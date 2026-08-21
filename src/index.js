// 불용재고 관리현황 대시보드 — Cloudflare Worker 백엔드
// - 라이브 트래커 상태 저장 (KV)
// - 이력(스냅샷) 저장/불러오기/삭제/링크공유
// - 간단 로그인(아이디/비밀번호, 세션 쿠키)
//
// 필요 바인딩 (wrangler.toml 참고):
//   KV Namespace: TRACKER_KV
//   Static Assets: ASSETS (public/ 폴더 = 대시보드 HTML)

const LIVE_KEY = "state:live";
const SNAP_PREFIX = "snap:";
const SNAP_LIST_KEY = "snap:__index__";
const USERS_KEY = "auth:users";
const SESSION_PREFIX = "sess:";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14일
const ATTACH_INDEX_PREFIX = "attach-index:"; // attach-index:<itemKey> -> [{id,filename,mime,size,uploadedAt,uploaderName}]
const ATTACH_DATA_PREFIX = "attach-data:"; // attach-data:<id> -> {itemKey,filename,mime,size,uploadedAt,uploaderId,uploaderName,dataBase64}
const MAX_ATTACH_BASE64_LEN = 14 * 1024 * 1024; // base64 기준 약 14MB (원본 약 10MB) 상한

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });
}

function readCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookieHeader(name, value, maxAgeSeconds) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

async function getSessionUser(request, env) {
  const token = readCookie(request, "session");
  if (!token) return null;
  const raw = await env.TRACKER_KV.get(SESSION_PREFIX + token);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function requireAuth(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) {
    return json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  return null;
}

async function ensureSeedUsers(env) {
  const existing = await env.TRACKER_KV.get(USERS_KEY);
  if (existing) return;
  // 최초 배포 시 1회만 생성되는 기본 계정 — 배포 후 반드시 비밀번호를 변경하세요.
  const seed = {
    admin: { password: "change-me-now", name: "관리자(최초설정)", role: "admin" },
  };
  await env.TRACKER_KV.put(USERS_KEY, JSON.stringify(seed));
}

async function handleLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const { id, password } = body;
  if (!id || !password) return json({ error: "아이디/비밀번호를 입력해주세요." }, { status: 400 });

  const usersRaw = await env.TRACKER_KV.get(USERS_KEY);
  const users = usersRaw ? JSON.parse(usersRaw) : {};
  const u = users[id];
  if (!u || u.password !== password) {
    return json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." }, { status: 401 });
  }
  const token = crypto.randomUUID();
  const session = { id, name: u.name || id, role: u.role === "admin" ? "admin" : "member" };
  await env.TRACKER_KV.put(SESSION_PREFIX + token, JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return json(
    { ok: true, user: session },
    { headers: { "Set-Cookie": setCookieHeader("session", token, SESSION_TTL_SECONDS) } }
  );
}

async function handleLogout(request, env) {
  const token = readCookie(request, "session");
  if (token) await env.TRACKER_KV.delete(SESSION_PREFIX + token);
  return json({ ok: true }, { headers: { "Set-Cookie": setCookieHeader("session", "", 0) } });
}

async function handleMe(request, env) {
  const user = await getSessionUser(request, env);
  return json({ user });
}

// ---- 라이브 상태 ----
// data 안에는 tracker(사전검토 트래커), verify(데이터 검증 체크리스트) 등
// 화면에서 팀 공유가 필요한 모든 값을 자유 형식으로 담습니다.
async function handleGetState(request, env) {
  const raw = await env.TRACKER_KV.get(LIVE_KEY);
  const state = raw ? JSON.parse(raw) : { data: {}, updatedAt: null, lastEditor: null };
  return json(state);
}

async function handlePostState(request, env) {
  const authErr = await requireAuth(request, env);
  if (authErr) return authErr;
  const user = await getSessionUser(request, env);
  const body = await request.json().catch(() => ({}));
  if (!body || typeof body.data !== "object") {
    return json({ error: "data 필드가 필요합니다." }, { status: 400 });
  }
  const state = {
    data: body.data,
    updatedAt: new Date().toISOString(),
    lastEditor: user.name,
  };
  await env.TRACKER_KV.put(LIVE_KEY, JSON.stringify(state));
  return json({ ok: true, updatedAt: state.updatedAt });
}

// ---- 스냅샷(이력) ----
async function getSnapIndex(env) {
  const raw = await env.TRACKER_KV.get(SNAP_LIST_KEY);
  return raw ? JSON.parse(raw) : [];
}
async function putSnapIndex(env, list) {
  await env.TRACKER_KV.put(SNAP_LIST_KEY, JSON.stringify(list));
}

async function handleListSnapshots(request, env) {
  const list = await getSnapIndex(env);
  list.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  return json({ snapshots: list });
}

async function handleCreateSnapshot(request, env) {
  const authErr = await requireAuth(request, env);
  if (authErr) return authErr;
  const user = await getSessionUser(request, env);
  const body = await request.json().catch(() => ({}));
  const liveRaw = await env.TRACKER_KV.get(LIVE_KEY);
  const live = liveRaw ? JSON.parse(liveRaw) : { data: {} };

  const id = crypto.randomUUID();
  const savedAt = new Date().toISOString();
  const meta = {
    id,
    label: (body.label || "").trim() || "저장된 이력",
    savedAt,
    editor: user.name,
  };
  await env.TRACKER_KV.put(SNAP_PREFIX + id, JSON.stringify({ ...meta, data: live.data }));

  const list = await getSnapIndex(env);
  list.push(meta);
  await putSnapIndex(env, list);

  return json({ ok: true, snapshot: meta });
}

async function handleGetSnapshot(request, env, id) {
  const raw = await env.TRACKER_KV.get(SNAP_PREFIX + id);
  if (!raw) return json({ error: "이력을 찾을 수 없습니다." }, { status: 404 });
  return json(JSON.parse(raw));
}

async function handleRestoreSnapshot(request, env, id) {
  const authErr = await requireAuth(request, env);
  if (authErr) return authErr;
  const user = await getSessionUser(request, env);
  const raw = await env.TRACKER_KV.get(SNAP_PREFIX + id);
  if (!raw) return json({ error: "이력을 찾을 수 없습니다." }, { status: 404 });
  const snap = JSON.parse(raw);
  const state = { data: snap.data, updatedAt: new Date().toISOString(), lastEditor: user.name + " (이력 불러오기)" };
  await env.TRACKER_KV.put(LIVE_KEY, JSON.stringify(state));
  return json({ ok: true });
}

async function handleDeleteSnapshot(request, env, id) {
  const authErr = await requireAuth(request, env);
  if (authErr) return authErr;
  await env.TRACKER_KV.delete(SNAP_PREFIX + id);
  const list = await getSnapIndex(env);
  await putSnapIndex(env, list.filter((s) => s.id !== id));
  return json({ ok: true });
}

// ---- 첨부파일 ----
async function getAttachIndex(env, itemKey) {
  const raw = await env.TRACKER_KV.get(ATTACH_INDEX_PREFIX + itemKey);
  return raw ? JSON.parse(raw) : [];
}
async function putAttachIndex(env, itemKey, list) {
  await env.TRACKER_KV.put(ATTACH_INDEX_PREFIX + itemKey, JSON.stringify(list));
}

async function handleAttachmentCounts(request, env) {
  const list = await env.TRACKER_KV.list({ prefix: ATTACH_INDEX_PREFIX });
  const counts = {};
  for (const k of list.keys) {
    const itemKey = k.name.slice(ATTACH_INDEX_PREFIX.length);
    const raw = await env.TRACKER_KV.get(k.name);
    const arr = raw ? JSON.parse(raw) : [];
    if (arr.length) counts[itemKey] = arr.length;
  }
  return json({ counts });
}

async function handleListAttachments(request, env, itemKey) {
  const list = await getAttachIndex(env, itemKey);
  return json({ attachments: list });
}

async function handleCreateAttachment(request, env) {
  const authErr = await requireAuth(request, env);
  if (authErr) return authErr;
  const user = await getSessionUser(request, env);
  const body = await request.json().catch(() => ({}));
  const { itemKey, filename, mime, dataBase64 } = body || {};
  if (!itemKey || !filename || !dataBase64) {
    return json({ error: "itemKey, filename, dataBase64가 필요합니다." }, { status: 400 });
  }
  if (dataBase64.length > MAX_ATTACH_BASE64_LEN) {
    return json({ error: "파일이 너무 큽니다 (최대 약 10MB)." }, { status: 413 });
  }
  const id = crypto.randomUUID();
  const size = Math.floor((dataBase64.length * 3) / 4);
  const uploadedAt = new Date().toISOString();
  const record = {
    itemKey,
    filename,
    mime: mime || "application/octet-stream",
    size,
    uploadedAt,
    uploaderId: user.id,
    uploaderName: user.name,
    dataBase64,
  };
  await env.TRACKER_KV.put(ATTACH_DATA_PREFIX + id, JSON.stringify(record));

  const meta = { id, filename, mime: record.mime, size, uploadedAt, uploaderName: user.name };
  const idx = await getAttachIndex(env, itemKey);
  idx.push(meta);
  await putAttachIndex(env, itemKey, idx);

  return json({ ok: true, attachment: meta });
}

async function handleGetAttachmentFile(request, env, id) {
  const raw = await env.TRACKER_KV.get(ATTACH_DATA_PREFIX + id);
  if (!raw) return new Response("Not found", { status: 404 });
  const record = JSON.parse(raw);
  const bin = Uint8Array.from(atob(record.dataBase64), (c) => c.charCodeAt(0));
  return new Response(bin, {
    headers: {
      "Content-Type": record.mime,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(record.filename)}`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}

async function handleDeleteAttachment(request, env, id) {
  const authErr = await requireAuth(request, env);
  if (authErr) return authErr;
  const user = await getSessionUser(request, env);
  const raw = await env.TRACKER_KV.get(ATTACH_DATA_PREFIX + id);
  if (!raw) return json({ error: "첨부파일을 찾을 수 없습니다." }, { status: 404 });
  const record = JSON.parse(raw);
  if (user.role !== "admin" && user.id !== record.uploaderId) {
    return json({ error: "삭제 권한이 없습니다 (업로더 본인 또는 관리자만 삭제 가능)." }, { status: 403 });
  }
  await env.TRACKER_KV.delete(ATTACH_DATA_PREFIX + id);
  const idx = await getAttachIndex(env, record.itemKey);
  await putAttachIndex(env, record.itemKey, idx.filter((a) => a.id !== id));
  return json({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname.startsWith("/api/")) {
      await ensureSeedUsers(env);
      try {
        if (pathname === "/api/login" && request.method === "POST") return await handleLogin(request, env);
        if (pathname === "/api/logout" && request.method === "POST") return await handleLogout(request, env);
        if (pathname === "/api/me" && request.method === "GET") return await handleMe(request, env);

        if (pathname === "/api/state" && request.method === "GET") return await handleGetState(request, env);
        if (pathname === "/api/state" && request.method === "POST") return await handlePostState(request, env);

        if (pathname === "/api/snapshots" && request.method === "GET") return await handleListSnapshots(request, env);
        if (pathname === "/api/snapshots" && request.method === "POST") return await handleCreateSnapshot(request, env);

        const snapMatch = pathname.match(/^\/api\/snapshots\/([a-zA-Z0-9-]+)(\/restore)?$/);
        if (snapMatch) {
          const id = snapMatch[1];
          const isRestore = !!snapMatch[2];
          if (isRestore && request.method === "POST") return await handleRestoreSnapshot(request, env, id);
          if (!isRestore && request.method === "GET") return await handleGetSnapshot(request, env, id);
          if (!isRestore && request.method === "DELETE") return await handleDeleteSnapshot(request, env, id);
        }

        if (pathname === "/api/attachments/counts" && request.method === "GET") return await handleAttachmentCounts(request, env);
        if (pathname === "/api/attachments" && request.method === "GET") {
          const itemKey = url.searchParams.get("itemKey");
          if (!itemKey) return json({ error: "itemKey가 필요합니다." }, { status: 400 });
          return await handleListAttachments(request, env, itemKey);
        }
        if (pathname === "/api/attachments" && request.method === "POST") return await handleCreateAttachment(request, env);

        const attachFileMatch = pathname.match(/^\/api\/attachments\/([a-zA-Z0-9-]+)\/file$/);
        if (attachFileMatch && request.method === "GET") return await handleGetAttachmentFile(request, env, attachFileMatch[1]);

        const attachMatch = pathname.match(/^\/api\/attachments\/([a-zA-Z0-9-]+)$/);
        if (attachMatch && request.method === "DELETE") return await handleDeleteAttachment(request, env, attachMatch[1]);

        return json({ error: "Not found" }, { status: 404 });
      } catch (e) {
        return json({ error: String(e && e.message ? e.message : e) }, { status: 500 });
      }
    }

    // 정적 자산(대시보드 HTML) 서빙
    return env.ASSETS.fetch(request);
  },
};

