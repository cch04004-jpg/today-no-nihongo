import { firebaseConfig } from "./firebase-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const loginBtn = document.getElementById("googleLogin");
const logoutBtn = document.getElementById("googleLogout");
const statusEl = document.getElementById("syncStatus");
const statusText = document.getElementById("syncStatusText");
const helpEl = document.getElementById("syncHelp");
const userChip = document.getElementById("userChip");
const userPhoto = document.getElementById("userPhoto");
const userName = document.getElementById("userName");

function setStatus(text, kind=""){
  statusText.textContent = text;
  statusEl.classList.remove("online","syncing","error");
  if(kind) statusEl.classList.add(kind);
}

function isConfigured(config){
  return !!(
    config &&
    config.apiKey &&
    config.projectId &&
    config.appId &&
    !String(config.apiKey).includes("YOUR_") &&
    !String(config.projectId).includes("YOUR_") &&
    !String(config.appId).includes("YOUR_")
  );
}

if(!isConfigured(firebaseConfig)){
  setStatus("연동 설정 필요", "error");
  statusEl.title = "Firebase 설정을 완료하면 Google 로그인과 자동 동기화를 사용할 수 있습니다.";
  loginBtn.disabled = true;
  helpEl.textContent = "Firebase 설정 전이라 지금은 기기에만 저장돼.";
} else {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const provider = new GoogleAuthProvider();

  let currentUser = null;
  let saveTimer = null;
  let applyingCloudState = false;

  function mergeUniqueWords(a=[], b=[]){
    const map = new Map();
    [...a, ...b].forEach(item => {
      if(item && item.word && !map.has(item.word)) map.set(item.word, item);
    });
    return [...map.values()];
  }

  function mergeStates(local, remote){
    if(!remote) return local;

    const localTime = Number(local.updatedAt || 0);
    const remoteTime = Number(remote.updatedAt || 0);
    const newer = remoteTime >= localTime ? remote : local;

    return {
      ...local,
      ...remote,
      todayWords: newer.todayWords || local.todayWords || remote.todayWords,
      quizScore: newer.quizScore ?? local.quizScore ?? remote.quizScore ?? null,
      learned: {...(remote.learned || {}), ...(local.learned || {})},
      wrong: {...(remote.wrong || {}), ...(local.wrong || {})},
      extraWords: mergeUniqueWords(remote.extraWords, local.extraWords),
      studyDates: [...new Set([...(remote.studyDates || []), ...(local.studyDates || [])])].sort(),
      updatedAt: Math.max(localTime, remoteTime)
    };
  }

  async function writeCloudState(){
    if(!currentUser || applyingCloudState) return;
    const state = window.jpStudy.getState();
    setStatus("동기화 중", "syncing");
    try{
      await setDoc(
        doc(db, "users", currentUser.uid, "study", "state"),
        {
          state,
          updatedAt: state.updatedAt || Date.now(),
          updatedAtServer: serverTimestamp()
        },
        {merge:true}
      );
      setStatus("동기화됨", "online");
      statusEl.title = "이 계정의 학습기록이 클라우드에 저장되었습니다.";
    }catch(error){
      console.error(error);
      setStatus("동기화 오류", "error");
      statusEl.title = error.message || "동기화 중 오류가 발생했습니다.";
    }
  }

  window.cloudSync = {
    scheduleSave(){
      if(!currentUser || applyingCloudState) return;
      clearTimeout(saveTimer);
      setStatus("저장 대기", "syncing");
      saveTimer = setTimeout(writeCloudState, 650);
    },
    saveNow: writeCloudState
  };

  async function loadAndMergeCloudState(user){
    setStatus("불러오는 중", "syncing");
    const ref = doc(db, "users", user.uid, "study", "state");
    try{
      const snap = await getDoc(ref);
      const local = window.jpStudy.getState();

      if(snap.exists() && snap.data().state){
        applyingCloudState = true;
        const merged = mergeStates(local, snap.data().state);
        window.jpStudy.replaceState(merged);
        applyingCloudState = false;
      }

      await writeCloudState();
    }catch(error){
      applyingCloudState = false;
      console.error(error);
      setStatus("불러오기 오류", "error");
      statusEl.title = error.message || "클라우드 기록을 불러오지 못했습니다.";
    }
  }

  loginBtn.addEventListener("click", async ()=>{
    try{
      setStatus("로그인 중", "syncing");
      helpEl.textContent = "Google 로그인 창을 확인해줘.";
      await setPersistence(auth, browserLocalPersistence);

      provider.setCustomParameters({
        prompt: "select_account"
      });

      await signInWithPopup(auth, provider);
    }catch(error){
      console.error("Firebase login error:", error);

      const code = error?.code || "unknown-error";
      setStatus("로그인 실패", "error");

      const messages = {
        "auth/unauthorized-domain":
          "현재 사이트 주소가 Firebase 승인 도메인에 없어요.",
        "auth/operation-not-allowed":
          "Firebase Authentication에서 Google 로그인 제공업체가 아직 활성화되지 않았어요.",
        "auth/popup-blocked":
          "브라우저가 Google 로그인 팝업을 차단했어요. 주소창의 팝업 차단 아이콘에서 이 사이트의 팝업을 허용해줘.",
        "auth/popup-closed-by-user":
          "Google 로그인 창이 완료되기 전에 닫혔어요. 다시 로그인해줘.",
        "auth/cancelled-popup-request":
          "로그인 창 요청이 취소됐어요. 잠시 후 다시 시도해줘.",
        "auth/network-request-failed":
          "네트워크 또는 광고/추적 차단 기능 때문에 Firebase 로그인 요청이 막혔을 수 있어요.",
        "auth/invalid-api-key":
          "Firebase API 키 설정을 확인해야 해요.",
        "auth/invalid-oauth-client-id":
          "Google OAuth 클라이언트 설정에 문제가 있어요. Firebase에서 Google 로그인 제공업체를 껐다가 다시 켜야 할 수 있어요.",
        "auth/web-storage-unsupported":
          "현재 브라우저가 로그인에 필요한 웹 저장소 사용을 막고 있어요. 시크릿 모드나 쿠키 차단 설정을 확인해줘."
      };

      const friendly = messages[code] || "Google 로그인을 완료하지 못했어.";
      helpEl.textContent = `${friendly}  [오류: ${code}]`;
      statusEl.title = error?.message || code;
    }
  });

  logoutBtn.addEventListener("click", async ()=>{
    await signOut(auth);
  });

  onAuthStateChanged(auth, async user=>{
    currentUser = user || null;

    if(user){
      loginBtn.hidden = true;
      logoutBtn.hidden = false;
      userChip.hidden = false;
      userName.textContent = user.displayName || user.email || "Google 계정";
      if(user.photoURL){
        userPhoto.src = user.photoURL;
        userPhoto.hidden = false;
      }else{
        userPhoto.hidden = true;
      }
      helpEl.textContent = "이 계정으로 로그인한 PC·모바일의 학습기록을 자동 동기화해.";
      await loadAndMergeCloudState(user);
    }else{
      loginBtn.hidden = false;
      logoutBtn.hidden = true;
      userChip.hidden = true;
      setStatus("기기 저장");
      statusEl.title = "로그인하지 않은 기록은 이 브라우저에만 저장됩니다.";
      helpEl.textContent = "로그인하면 PC와 모바일의 학습기록이 자동으로 동기화돼.";
    }
  });
}
