import fs from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { record } from "./env-probe.mjs";
export default function (pi: any) {
  const log = (kind: string, extra = {}) => fs.appendFileSync(process.env.PROBE_LOG!, JSON.stringify({kind,timestamp:Date.now(),pid:process.pid,...extra})+"\n");
  let timers: ReturnType<typeof setTimeout>[] = [];
  function tools(at: string) { log("tools", {at,all:pi.getAllTools().map((t:any)=>t.name),active:pi.getActiveTools()}); }
  pi.on("session_start", (_event:any, ctx:any) => {
    const marker = {timestamp:Date.now(),sessionId:ctx.sessionManager.getSessionId(),sessionFile:ctx.sessionManager.getSessionFile() ?? null,pid:process.pid};
    fs.writeFileSync(process.env.PROBE_MARKER!,JSON.stringify(marker),{mode:0o600});
    log("session_start",marker);
    record("host");
    tools("session_start");
    timers = [100,500,1500,3000].map(ms=>setTimeout(()=>tools(`${ms}ms`),ms));
  });
  pi.on("session_shutdown",()=>{timers.forEach(clearTimeout);log("session_shutdown");});
  pi.on("tool_call",(event:any)=>{log("tool_call",{toolName:event.toolName});});
  pi.on("tool_result",(event:any)=>{log("tool_result",{toolName:event.toolName,isError:event.isError});});
  pi.registerCommand("probe-tools",{description:"Record synthetic tool inventory",handler:async()=>tools("command")});
  let savedTools: string[] = [];
  pi.registerCommand("probe-disable-cct",{description:"Temporarily hide direct CCT tools",handler:async()=>{savedTools=pi.getActiveTools();pi.setActiveTools(savedTools.filter((n:string)=>!n.startsWith("cct_")));}});
  pi.registerCommand("probe-enable-cct",{description:"Restore direct CCT tools",handler:async()=>{pi.setActiveTools(savedTools);}});
  pi.registerProvider("cct-probe", {
    baseUrl:"http://127.0.0.1:1", apiKey:"synthetic-local", api:"cct-probe-api",
    models:[{id:"local",name:"Local synthetic probe",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:1000}],
    streamSimple(model:any,context:any) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const text = typeof last?.content === "string" ? last.content : last?.content?.filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("") ?? "";
      let requested:any;
      for (let i=context.messages.length-1;i>=0;i--) {
        const msg=context.messages[i];
        if (msg.role==="toolResult") break;
        const txt=typeof msg.content==="string"?msg.content:msg.content?.filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("") ?? "";
        if (msg.role==="user" && txt.startsWith("PROBE_TOOL ")) {requested=JSON.parse(txt.slice(11));break;}
      }
      const content = requested
        ? [{type:"toolCall",id:`probe-${Date.now()}`,name:requested.name,arguments:requested.arguments}]
        : [{type:"text",text:"Synthetic probe complete."}];
      const stopReason = content[0].type === "toolCall" ? "toolUse" : "stop";
      const output:any = {role:"assistant",content,api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason,timestamp:Date.now()};
      queueMicrotask(()=>{stream.push({type:"start",partial:output});stream.push({type:"done",reason:stopReason,message:output});stream.end();});
      return stream;
    }
  });
}
