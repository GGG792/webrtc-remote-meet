/* =========================================================
   RemoteMeet - WebRTC 远程通话与屏幕共享
   基于 PeerJS 公共信令服务器，纯前端可部署在 GitHub Pages
   ========================================================= */

const PEER_PREFIX = "remote-";

// DOM 元素
const lobby = document.getElementById("lobby");
const roomView = document.getElementById("room");
const roomNameInput = document.getElementById("roomName");
const btnGenerate = document.getElementById("btnGenerate");
const btnCreate = document.getElementById("btnCreate");
const btnJoin = document.getElementById("btnJoin");
const shareBox = document.getElementById("shareBox");
const shareLink = document.getElementById("shareLink");
const btnCopy = document.getElementById("btnCopy");
const currentRoom = document.getElementById("currentRoom");
const btnLeave = document.getElementById("btnLeave");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const remotePlaceholder = document.getElementById("remotePlaceholder");
const btnMic = document.getElementById("btnMic");
const btnCam = document.getElementById("btnCam");
const btnScreen = document.getElementById("btnScreen");
const btnHangup = document.getElementById("btnHangup");
const messageLog = document.getElementById("messageLog");
const connStatus = document.getElementById("connStatus");
const statusText = document.getElementById("statusText");

// 全局状态
let peer = null;
let localStream = null;
let screenStream = null;
let currentCall = null;
let currentRoomName = "";
let isHost = false;
let micOn = true;
let camOn = true;
let screenSharing = false;

/* ---------------- 工具函数 ---------------- */

function log(msg, type = "") {
  const div = document.createElement("div");
  div.className = "msg " + type;
  div.textContent = "[" + new Date().toLocaleTimeString() + "] " + msg;
  messageLog.appendChild(div);
  messageLog.scrollTop = messageLog.scrollHeight;
}

function setStatus(state, text) {
  connStatus.className = "status " + state;
  statusText.textContent = text;
}

function randomRoomName() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

function getMediaConstraints() {
  return {
    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: true,
  };
}

/* ---------------- 媒体控制 ---------------- */

async function startLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia(getMediaConstraints());
    localVideo.srcObject = localStream;
    log("已获取本地摄像头/麦克风", "success");
    return true;
  } catch (err) {
    log("获取摄像头/麦克风失败：" + err.message, "error");
    return false;
  }
}

function toggleMic() {
  if (!localStream) return;
  micOn = !micOn;
  localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
  btnMic.classList.toggle("muted", !micOn);
  btnMic.querySelector(".ctrl-text").textContent = micOn ? "麦克风开" : "麦克风关";
  log(micOn ? "麦克风已开启" : "麦克风已静音");
}

function toggleCam() {
  if (!localStream) return;
  camOn = !camOn;
  localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
  btnCam.classList.toggle("muted", !camOn);
  btnCam.querySelector(".ctrl-text").textContent = camOn ? "摄像头开" : "摄像头关";
  log(camOn ? "摄像头已开启" : "摄像头已关闭");
}

async function toggleScreenShare() {
  if (screenSharing) {
    stopScreenShare();
    return;
  }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
    screenSharing = true;
    btnScreen.classList.add("active");
    btnScreen.querySelector(".ctrl-text").textContent = "停止共享";

    // 替换本地视频显示
    localVideo.srcObject = screenStream;

    // 替换发送给对方的视频轨
    if (currentCall) {
      const sender = currentCall.peerConnection
        .getSenders()
        .find((s) => s.track && s.track.kind === "video");
      if (sender) {
        sender.replaceTrack(screenStream.getVideoTracks()[0]);
      }
      // 若屏幕共享带音频，也发送
      const screenAudio = screenStream.getAudioTracks()[0];
      if (screenAudio) {
        currentCall.peerConnection.addTrack(screenAudio, screenStream);
      }
    }

    log("屏幕共享已开启", "success");

    screenStream.getVideoTracks()[0].onended = () => stopScreenShare();
  } catch (err) {
    log("屏幕共享失败：" + err.message, "error");
  }
}

function stopScreenShare() {
  if (screenStream) {
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
  }
  screenSharing = false;
  btnScreen.classList.remove("active");
  btnScreen.querySelector(".ctrl-text").textContent = "共享屏幕";

  // 恢复本地摄像头显示
  if (localStream) localVideo.srcObject = localStream;

  // 恢复发送摄像头视频轨
  if (currentCall && localStream) {
    const camTrack = localStream.getVideoTracks()[0];
    const sender = currentCall.peerConnection
      .getSenders()
      .find((s) => s.track && s.track.kind === "video");
    if (sender && camTrack) sender.replaceTrack(camTrack);
  }
  log("屏幕共享已停止");
}

/* ---------------- PeerJS 连接 ---------------- */

function createPeer(roomName, asHost) {
  isHost = asHost;
  const peerId = asHost ? PEER_PREFIX + roomName : PEER_PREFIX + roomName + "-g-" + randomRoomName();
  peer = new Peer(peerId, {
    host: "0.peerjs.com",
    port: 443,
    path: "/",
    secure: true,
    debug: 1,
  });

  setStatus("connecting", "连接信令服务器…");

  peer.on("open", (id) => {
    setStatus("connected", "已连接");
    log("Peer 已连接，ID: " + id, "success");
    if (asHost) {
      log("等待对方加入房间…");
      peer.on("call", answerCall);
    } else {
      callHost(roomName);
    }
  });

  peer.on("error", (err) => {
    log("Peer 错误：" + err.message, "error");
    if (err.type === "unavailable-id" && asHost) {
      log("该房间号已被占用，请换一个", "error");
    }
    setStatus("error", "连接错误");
  });

  peer.on("disconnected", () => {
    setStatus("error", "信令服务器断开");
  });
}

function callHost(roomName) {
  const hostId = PEER_PREFIX + roomName;
  log("正在呼叫房间主人 " + hostId + "…");
  if (!localStream) {
    log("本地媒体未就绪，无法发起通话", "error");
    return;
  }
  currentCall = peer.call(hostId, localStream);
  currentCall.on("stream", handleRemoteStream);
  currentCall.on("close", () => {
    log("通话已结束");
    remoteVideo.srcObject = null;
    remotePlaceholder.style.display = "flex";
  });
  currentCall.on("error", (err) => {
    log("通话错误：" + err.message, "error");
  });
}

function answerCall(call) {
  log("收到对方来电，正在接听…");
  currentCall = call;
  call.answer(localStream);
  call.on("stream", handleRemoteStream);
  call.on("close", () => {
    log("对方已离开通话");
    remoteVideo.srcObject = null;
    remotePlaceholder.style.display = "flex";
  });
}

function handleRemoteStream(stream) {
  remoteVideo.srcObject = stream;
  remotePlaceholder.style.display = "none";
  log("已连接到对方，通话中…", "success");
}

/* ---------------- 房间流程 ---------------- */

function enterRoom(roomName) {
  currentRoomName = roomName;
  currentRoom.textContent = roomName;
  lobby.style.display = "none";
  roomView.style.display = "flex";
}

function leaveRoom() {
  if (currentCall) {
    currentCall.close();
    currentCall = null;
  }
  if (screenSharing) stopScreenShare();
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  if (peer) {
    peer.destroy();
    peer = null;
  }
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  remotePlaceholder.style.display = "flex";
  messageLog.innerHTML = "";
  lobby.style.display = "flex";
  roomView.style.display = "none";
  shareBox.style.display = "none";
  setStatus("", "未连接");
}

/* ---------------- 事件绑定 ---------------- */

btnGenerate.addEventListener("click", () => {
  roomNameInput.value = randomRoomName();
});

btnCreate.addEventListener("click", async () => {
  const name = roomNameInput.value.trim();
  if (!name) {
    alert("请输入或生成房间号");
    return;
  }
  const ok = await startLocalMedia();
  if (!ok) return;
  enterRoom(name);
  createPeer(name, true);
  // 生成分享链接
  const url = location.origin + location.pathname + "?room=" + encodeURIComponent(name) + "#join";
  shareLink.value = url;
  shareBox.style.display = "block";
});

btnJoin.addEventListener("click", async () => {
  const name = roomNameInput.value.trim();
  if (!name) {
    alert("请输入房间号");
    return;
  }
  const ok = await startLocalMedia();
  if (!ok) return;
  enterRoom(name);
  createPeer(name, false);
});

btnCopy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(shareLink.value);
    btnCopy.textContent = "已复制";
    setTimeout(() => (btnCopy.textContent = "复制"), 1500);
  } catch {
    shareLink.select();
    document.execCommand("copy");
    btnCopy.textContent = "已复制";
    setTimeout(() => (btnCopy.textContent = "复制"), 1500);
  }
});

btnMic.addEventListener("click", toggleMic);
btnCam.addEventListener("click", toggleCam);
btnScreen.addEventListener("click", toggleScreenShare);
btnHangup.addEventListener("click", leaveRoom);
btnLeave.addEventListener("click", leaveRoom);

// 页面 URL 带 join 时自动填入房间号
const urlParams = new URLSearchParams(location.search);
const roomParam = urlParams.get("room");
if (roomParam) {
  roomNameInput.value = roomParam;
}

window.addEventListener("beforeunload", () => {
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  if (peer) peer.destroy();
});
