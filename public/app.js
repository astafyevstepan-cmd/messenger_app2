/* ===================== STATE ===================== */
let currentUser = null;
let socket = null;
let activeChatId = null;
let conversations = []; // list of {id, username, displayName, color, lastText, lastTime, unread}
let messagesCache = {}; // userId -> [messages]
let typingTimeout = null;

const API = "";

/* ===================== HELPERS ===================== */
function initials(name){
  return name.split(" ").map(w=>w[0]).slice(0,2).join("").toUpperCase();
}
function escapeHtml(str){
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
function fmtTime(ts){
  const d = new Date(ts);
  return d.getHours().toString().padStart(2,"0")+":"+d.getMinutes().toString().padStart(2,"0");
}
function getToken(){
  return localStorage.getItem("token");
}

async function apiFetch(url, opts={}){
  opts.headers = Object.assign({"Content-Type":"application/json"}, opts.headers || {});
  const token = getToken();
  if(token) opts.headers["Authorization"] = "Bearer " + token;
  opts.credentials = "include";
  const res = await fetch(API+url, opts);
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error || "Ошибка запроса");
  return data;
}

/* ===================== AUTH UI ===================== */
const authScreen = document.getElementById("authScreen");
const appEl = document.getElementById("app");
const tabLogin = document.getElementById("tabLogin");
const tabRegister = document.getElementById("tabRegister");
const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");

tabLogin.onclick = () => {
  tabLogin.classList.add("active"); tabRegister.classList.remove("active");
  loginForm.classList.remove("hidden"); registerForm.classList.add("hidden");
};
tabRegister.onclick = () => {
  tabRegister.classList.add("active"); tabLogin.classList.remove("active");
  registerForm.classList.remove("hidden"); loginForm.classList.add("hidden");
};

loginForm.addEventListener("submit", async e=>{
  e.preventDefault();
  const username = document.getElementById("loginUsername").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errEl = document.getElementById("loginError");
  errEl.textContent = "";
  try{
    const data = await apiFetch("/api/login", { method:"POST", body: JSON.stringify({username, password}) });
    localStorage.setItem("token", data.token);
    startApp(data.user);
  }catch(err){
    errEl.textContent = err.message;
  }
});

registerForm.addEventListener("submit", async e=>{
  e.preventDefault();
  const displayName = document.getElementById("regDisplayName").value.trim();
  const username = document.getElementById("regUsername").value.trim();
  const password = document.getElementById("regPassword").value;
  const errEl = document.getElementById("registerError");
  errEl.textContent = "";
  try{
    const data = await apiFetch("/api/register", { method:"POST", body: JSON.stringify({username, password, displayName}) });
    localStorage.setItem("token", data.token);
    startApp(data.user);
  }catch(err){
    errEl.textContent = err.message;
  }
});

document.getElementById("logoutBtn").onclick = async () => {
  try{ await apiFetch("/api/logout", {method:"POST"}); }catch(e){}
  localStorage.removeItem("token");
  if(socket) socket.disconnect();
  currentUser = null;
  activeChatId = null;
  messagesCache = {};
  conversations = [];
  appEl.classList.add("hidden");
  authScreen.classList.remove("hidden");
};

/* ===================== APP START ===================== */
async function tryAutoLogin(){
  const token = getToken();
  if(!token) return;
  try{
    const user = await apiFetch("/api/me");
    startApp(user);
  }catch(e){
    localStorage.removeItem("token");
  }
}

function startApp(user){
  currentUser = user;
  authScreen.classList.add("hidden");
  appEl.classList.remove("hidden");

  document.getElementById("myAvatar").textContent = initials(user.displayName);
  document.getElementById("myAvatar").style.background = user.color;
  document.getElementById("myName").textContent = user.displayName;

  connectSocket();
  loadConversations();
}

/* ===================== SOCKET.IO ===================== */
function connectSocket(){
  socket = io({ auth: { token: getToken() } });

  socket.on("new_message", msg => {
    const otherId = msg.from === currentUser.id ? msg.to : msg.from;
    if(!messagesCache[otherId]) messagesCache[otherId] = [];
    messagesCache[otherId].push(msg);

    if(activeChatId === otherId){
      renderMessages(otherId);
    }
    loadConversations(); // обновить список чатов и время последнего сообщения
  });

  socket.on("presence", ({userId, online}) => {
    const conv = conversations.find(c=>c.id===userId);
    if(conv){ conv.online = online; renderChatList(); }
    if(activeChatId === userId){
      updateHeaderStatus(online);
    }
  });

  socket.on("typing", ({from}) => {
    if(activeChatId === from){
      const el = document.getElementById("typingIndicator");
      if(el){
        const conv = conversations.find(c=>c.id===from);
        el.textContent = (conv ? conv.displayName : "Собеседник") + " печатает...";
        el.style.opacity = 1;
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(()=>{ el.style.opacity = 0; }, 2000);
      }
    }
  });
}

/* ===================== CONVERSATIONS / CHAT LIST ===================== */
const chatListEl = document.getElementById("chatList");
const searchInput = document.getElementById("searchInput");
let searchMode = false;

async function loadConversations(){
  try{
    const data = await apiFetch("/api/conversations");
    conversations = data;
    if(!searchMode) renderChatList();
  }catch(e){ console.error(e); }
}

function renderChatList(){
  searchMode = false;
  chatListEl.innerHTML = "";
  if(conversations.length === 0){
    chatListEl.innerHTML = `<div class="search-result-hint">У вас пока нет чатов. Найдите пользователя через поиск выше 👆</div>`;
    return;
  }
  conversations.forEach(c=>{
    const item = document.createElement("div");
    item.className = "chat-item" + (activeChatId===c.id ? " active":"");
    item.onclick = () => openChat(c);
    item.innerHTML = `
      <div class="avatar" style="background:${c.color}">
        ${initials(c.displayName)}
        ${c.online ? '<span class="status-dot"></span>' : ''}
      </div>
      <div class="chat-info">
        <div class="row1">
          <span class="name">${escapeHtml(c.displayName)}</span>
          <span class="time">${c.lastTime ? fmtTime(c.lastTime) : ""}</span>
        </div>
        <div class="row2">
          <span class="last-msg">${c.lastText ? escapeHtml(c.lastText) : ""}</span>
          ${c.unread ? `<span class="unread-badge">${c.unread}</span>` : ""}
        </div>
      </div>
    `;
    chatListEl.appendChild(item);
  });
}

let searchDebounce;
searchInput.addEventListener("input", e=>{
  clearTimeout(searchDebounce);
  const q = e.target.value.trim();
  if(!q){ renderChatList(); return; }
  searchDebounce = setTimeout(()=> doSearch(q), 300);
});

async function doSearch(q){
  try{
    const results = await apiFetch("/api/users?q="+encodeURIComponent(q));
    searchMode = true;
    chatListEl.innerHTML = `<div class="search-result-hint">Результаты поиска</div>`;
    if(results.length===0){
      chatListEl.innerHTML += `<div class="search-result-hint">Никого не найдено</div>`;
      return;
    }
    results.forEach(u=>{
      const item = document.createElement("div");
      item.className = "chat-item";
      item.onclick = () => openChat(u);
      item.innerHTML = `
        <div class="avatar" style="background:${u.color}">${initials(u.displayName)}</div>
        <div class="chat-info">
          <div class="row1"><span class="name">${escapeHtml(u.displayName)}</span></div>
          <div class="row2"><span class="last-msg">@${escapeHtml(u.username)}</span></div>
        </div>
      `;
      chatListEl.appendChild(item);
    });
  }catch(e){ console.error(e); }
}

/* ===================== CHAT WINDOW ===================== */
const chatWindowEl = document.getElementById("chatWindow");

async function openChat(user){
  activeChatId = user.id;
  searchInput.value = "";

  chatWindowEl.innerHTML = `
    <div class="chat-header">
      <button class="back-btn" id="backBtn">←</button>
      <div class="avatar" style="background:${user.color};width:40px;height:40px;font-size:15px;" id="headerAvatar">
        ${initials(user.displayName)}
      </div>
      <div>
        <div class="name">${escapeHtml(user.displayName)}</div>
        <div class="status" id="headerStatus">...</div>
      </div>
    </div>
    <div class="messages" id="messages"></div>
    <div class="typing-indicator" id="typingIndicator" style="opacity:0;"></div>
    <div class="input-area">
      <input type="text" id="msgInput" placeholder="Написать сообщение...">
      <button class="send-btn" id="sendBtn">➤</button>
    </div>
  `;

  const input = document.getElementById("msgInput");
  document.getElementById("sendBtn").onclick = sendMessage;
  input.addEventListener("keydown", e=>{ if(e.key==="Enter") sendMessage(); });
  input.addEventListener("input", ()=>{
    if(socket) socket.emit("typing", { to: activeChatId });
  });
  input.focus();

  const backBtn = document.getElementById("backBtn");
  if(backBtn) backBtn.onclick = ()=> document.getElementById("sidebar").classList.remove("hidden-mobile");
  document.getElementById("sidebar").classList.add("hidden-mobile");

  // подгрузить онлайн-статус
  try{
    const st = await apiFetch("/api/online/"+user.id);
    updateHeaderStatus(st.online);
  }catch(e){}

  // подгрузить сообщения
  try{
    const msgs = await apiFetch("/api/messages/"+user.id);
    messagesCache[user.id] = msgs;
    renderMessages(user.id);
  }catch(e){ console.error(e); }

  renderChatList();
  loadConversations();
}

function updateHeaderStatus(online){
  const el = document.getElementById("headerStatus");
  if(el) el.textContent = online ? "в сети" : "не в сети";
}

function renderMessages(userId){
  const container = document.getElementById("messages");
  if(!container) return;
  const msgs = messagesCache[userId] || [];
  container.innerHTML = msgs.map(m => `
    <div class="msg-row ${m.from===currentUser.id ? 'out':'in'}">
      <div class="bubble ${m.from===currentUser.id ? 'out':'in'}">
        ${escapeHtml(m.text)}
        <span class="meta">${fmtTime(m.createdAt)}</span>
      </div>
    </div>
  `).join("");
  container.scrollTop = container.scrollHeight;
}

function sendMessage(){
  const input = document.getElementById("msgInput");
  const text = input.value.trim();
  if(!text || !activeChatId) return;
  socket.emit("send_message", { to: activeChatId, text });
  input.value = "";
}

/* ===================== INIT ===================== */
tryAutoLogin();
