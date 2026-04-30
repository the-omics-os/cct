// --- Database row types (match SQLite schema exactly) ---

export interface Peer {
  id: string;
  name: string;
  secret: string;
  pid: number;
  pid_start: string;
  cwd: string;
  git_root: string | null;
  git_branch: string | null;
  summary: string;
  status: "active" | "dead";
  registered_at: string;
  last_seen: string;
}

export interface Pool {
  id: string;
  name: string;
  purpose: string;
  status: "active" | "archived";
  created_by: string;
  created_at: string;
}

export interface PoolMember {
  pool_id: string;
  peer_id: string;
  role: "creator" | "admin" | "member";
  status: "active" | "invited" | "left";
  joined_at: string;
  left_at: string | null;
}

export interface Message {
  id: number;
  pool_id: string | null;
  from_id: string;
  body: string;
  msg_type: "chat" | "system" | "join" | "leave";
  seq: number;
  created_at: string;
}

export interface MessageRecipient {
  message_id: number;
  peer_id: string;
  read_at: string | null;
}

// --- Broker response envelope ---

export interface BrokerResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// --- Request types ---

export interface RegisterRequest {
  pid: number;
  pid_start: string;
  cwd: string;
  name?: string;
  git_root?: string;
  git_branch?: string;
}

export interface RegisterResponse {
  id: string;
  secret: string;
  name: string;
}

export interface HeartbeatRequest {
  peer_id: string;
  peer_secret: string;
}

export interface UnregisterRequest {
  peer_id: string;
  peer_secret: string;
}

export interface SetSummaryRequest {
  peer_id: string;
  peer_secret: string;
  summary: string;
}

export interface ListPeersRequest {
  peer_id?: string;
}

export interface PeerInfo {
  id: string;
  name: string;
  pid: number;
  cwd: string;
  git_root: string | null;
  git_branch: string | null;
  summary: string;
  status: string;
  registered_at: string;
  last_seen: string;
  pools: { pool_id: string; pool_name: string; role: string }[];
}

// --- Pool request/response types ---

export interface PoolCreateRequest {
  peer_id: string;
  peer_secret: string;
  name: string;
  purpose?: string;
}

export interface PoolCreateResponse {
  pool_id: string;
  name: string;
}

export interface PoolJoinRequest {
  peer_id: string;
  peer_secret: string;
  pool_name: string;
}

export interface PoolLeaveRequest {
  peer_id: string;
  peer_secret: string;
  pool_name: string;
}

export interface PoolInviteRequest {
  peer_id: string;
  peer_secret: string;
  target_peer_id: string;
  pool_name: string;
}

export interface PoolListRequest {
  peer_id?: string;
}

export interface PoolMembersRequest {
  pool_name: string;
}

export interface PoolStatusRequest {
  pool_name: string;
}

export interface PoolInfo {
  id: string;
  name: string;
  purpose: string;
  status: string;
  created_by: string;
  created_at: string;
  members: { peer_id: string; peer_name: string; role: string; status: string }[];
}

export interface PoolStatusResponse {
  id: string;
  name: string;
  purpose: string;
  status: string;
  created_by: string;
  created_at: string;
  members: { peer_id: string; peer_name: string; role: string; status: string }[];
  recent_message_count: number;
}

// --- Message request/response types ---

export interface MessageSendRequest {
  peer_id: string;
  peer_secret: string;
  pool_name?: string;
  to_peer_id?: string;
  body: string;
  msg_type?: string;
}

export interface MessageCheckRequest {
  peer_id: string;
  peer_secret: string;
}

export interface MessageCheckResponse {
  messages: PollMessage[];
  unread: UnreadCountResponse;
  busy_peers: BusyPeerInfo[];
}

export interface StaleRecipientInfo {
  peer_id: string;
  peer_name: string;
  last_seen: string;
  age_seconds: number;
}

export interface MessageSendResponse {
  message_id: number;
  seq: number;
  recipient_count: number;
  stale_recipients?: StaleRecipientInfo[];
}

export interface MessagePollRequest {
  peer_id: string;
}

export interface PollMessage {
  message_id: number;
  pool_id: string | null;
  pool_name: string | null;
  from_id: string;
  from_name: string;
  from_cwd: string | null;
  from_branch: string | null;
  from_summary: string | null;
  body: string;
  msg_type: string;
  seq: number;
  created_at: string;
}

export interface MessageReadRequest {
  peer_id: string;
  peer_secret: string;
  message_ids: number[];
}

export interface UnreadCountRequest {
  peer_id: string;
}

export interface UnreadCountResponse {
  total: number;
  by_pool: { pool_id: string | null; pool_name: string | null; count: number }[];
}

// --- Release consensus types ---

export interface ReleaseProposal {
  id: string;
  pool_id: string;
  target_peer_id: string;
  proposed_by: string;
  reason: string;
  quorum_rule: "unanimous" | "majority";
  status: "open" | "approved" | "rejected" | "expired";
  created_at: string;
  resolved_at: string | null;
}

export interface ReleaseVote {
  release_id: string;
  voter_peer_id: string;
  vote: "yes" | "no";
  cast_at: string;
}

export interface ProposeReleaseRequest {
  peer_id: string;
  peer_secret: string;
  pool_name: string;
  target_peer_id: string;
  reason?: string;
}

export interface ProposeReleaseResponse {
  release_id: string;
  quorum_rule: string;
  members_count: number;
}

export interface VoteReleaseRequest {
  peer_id: string;
  peer_secret: string;
  release_id: string;
  vote: "yes" | "no";
}

export interface VoteReleaseResponse {
  voted: boolean;
  status: string;
  yes_count: number;
  no_count: number;
  quorum_needed: number;
}

export interface ReleaseStatusRequest {
  pool_name: string;
  peer_id?: string;
}

export interface ReleaseStatusResponse {
  proposals: {
    id: string;
    target_peer_name: string;
    target_peer_id: string;
    proposed_by_name: string;
    reason: string;
    status: string;
    quorum_rule: string;
    yes_count: number;
    no_count: number;
    quorum_needed: number;
    created_at: string;
  }[];
}

// --- Busy signaling types (deprecated — use pool throttle) ---

/** @deprecated Use SetPoolIdleRequest */
export interface SetBusyRequest {
  peer_id: string;
  peer_secret: string;
  pool_name: string;
  minutes: number;
  reason?: string;
}

/** @deprecated Use ClearPoolIdleRequest */
export interface SetReadyRequest {
  peer_id: string;
  peer_secret: string;
  pool_name: string;
}

/** @deprecated Use PoolThrottleInfo */
export interface BusyPeerInfo {
  peer_id: string;
  peer_name: string;
  busy_until: string;
  busy_reason: string;
}

// --- Pool throttle types ---

export interface SetPoolIdleRequest {
  peer_id: string;
  peer_secret: string;
  pool_name: string;
  minutes: number;
  reason?: string;
  force?: boolean;
}

export interface SetPoolIdleResponse {
  approved: boolean;
  idle_until?: string;
  reason?: string;
  activity?: {
    recent_chat_count: number;
    recent_distinct_senders: string[];
    window_minutes: number;
    unread_from_others: number;
  };
}

export interface ClearPoolIdleRequest {
  peer_id: string;
  peer_secret: string;
  pool_name: string;
}

export interface PoolThrottleInfo {
  pool_id: string;
  pool_name: string;
  set_by_peer_id: string;
  set_by_peer_name: string;
  idle_until: string;
  reason: string;
}

// --- Health ---

export interface HealthResponse {
  status: "ok";
  peers: number;
  pools: number;
}
