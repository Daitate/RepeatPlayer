// === アプリケーション状態 ===
const state = {
    mode: 'youtube',       // 'youtube' | 'local'
    pointA: null,
    pointB: null,
    isLoopEnabled: true,
    speed: 1.0,
    mediaDuration: 0,
    isPlaying: false,
    currentBlobUrl: null   // メモリリーク防止用
};

// === セッション保存/復元 (localStorage + IndexedDB) ===

var SESSION_KEY = 'repeatplayer_session';
var DB_NAME = 'RepeatPlayerDB';
var DB_STORE = 'files';

function openFileDB() {
    return new Promise(function(resolve, reject) {
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function(e) {
            e.target.result.createObjectStore(DB_STORE);
        };
        req.onsuccess = function(e) { resolve(e.target.result); };
        req.onerror = function(e) { reject(e.target.error); };
    });
}

function saveFileToDB(fileData, fileName, fileType) {
    return openFileDB().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx = db.transaction(DB_STORE, 'readwrite');
            var store = tx.objectStore(DB_STORE);
            store.clear(); // 直前のファイルのみ保持
            store.put({ data: fileData, name: fileName, type: fileType }, 'lastFile');
            tx.oncomplete = function() { resolve(); };
            tx.onerror = function(e) { reject(e.target.error); };
        });
    });
}

function loadFileFromDB() {
    return openFileDB().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx = db.transaction(DB_STORE, 'readonly');
            var store = tx.objectStore(DB_STORE);
            var req = store.get('lastFile');
            req.onsuccess = function() { resolve(req.result || null); };
            req.onerror = function(e) { reject(e.target.error); };
        });
    });
}

function clearFileDB() {
    return openFileDB().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx = db.transaction(DB_STORE, 'readwrite');
            tx.objectStore(DB_STORE).clear();
            tx.oncomplete = function() { resolve(); };
            tx.onerror = function(e) { reject(e.target.error); };
        });
    });
}

function saveSession() {
    var session = {
        mode: state.mode,
        pointA: state.pointA,
        pointB: state.pointB,
        isLoopEnabled: state.isLoopEnabled,
        speed: state.speed,
        youtubeUrl: document.getElementById('youtube-url').value,
        memo: el.memo.value
    };
    try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch (e) {
        console.warn('セッション保存に失敗:', e);
    }
}

function restoreSession() {
    var raw;
    try {
        raw = localStorage.getItem(SESSION_KEY);
    } catch (e) {
        return;
    }
    if (!raw) return;

    var session;
    try {
        session = JSON.parse(raw);
    } catch (e) {
        return;
    }

    // 速度の復元
    if (typeof session.speed === 'number') {
        state.speed = session.speed;
        el.speedSlider.value = session.speed;
        el.speedDisplay.textContent = session.speed.toFixed(2) + 'x';
        updateSpeedPresets();
    }

    // ループの復元
    if (typeof session.isLoopEnabled === 'boolean') {
        state.isLoopEnabled = session.isLoopEnabled;
        el.loopSwitch.checked = session.isLoopEnabled;
        el.loopStatus.textContent = session.isLoopEnabled ? 'ループON' : 'ループOFF';
    }

    // メモの復元
    if (session.memo) {
        el.memo.value = session.memo;
    }

    // モードとメディアの復元
    var restoreMode = session.mode || 'youtube';

    if (restoreMode === 'youtube') {
        if (session.youtubeUrl) {
            document.getElementById('youtube-url').value = session.youtubeUrl;
        }
        // YouTube APIの準備完了を待ってから読み込み＆ABポイント復元
        waitForYtReady(function() {
            if (session.youtubeUrl && extractYtId(session.youtubeUrl)) {
                var videoId = extractYtId(session.youtubeUrl);
                el.mediaContainer.classList.remove('audio-mode');
                ytPlayer.cueVideoById(videoId); // 自動再生しない
                ytPlayer.setPlaybackRate(state.speed);

                // メタデータ取得を待ってABポイントを復元
                restoreAbPoints(session.pointA, session.pointB);
            }
        });
    } else if (restoreMode === 'local') {
        // モード切替（リセットなし版）
        switchModeNoReset('local');

        // IndexedDBからファイルを復元
        loadFileFromDB().then(function(fileRecord) {
            if (!fileRecord) return;

            var blob = new Blob([fileRecord.data], { type: fileRecord.type });
            var objectUrl = URL.createObjectURL(blob);

            if (state.currentBlobUrl) {
                URL.revokeObjectURL(state.currentBlobUrl);
            }
            state.currentBlobUrl = objectUrl;

            var isAudio = fileRecord.type.startsWith('audio/');
            if (isAudio) {
                el.mediaContainer.classList.add('audio-mode');
            } else {
                el.mediaContainer.classList.remove('audio-mode');
            }
            el.fileName.textContent = fileRecord.name;

            localPlayer.src = objectUrl;
            localPlayer.load();
            localPlayer.preservesPitch = true;
            localPlayer.playbackRate = state.speed;

            localPlayer.onloadedmetadata = function() {
                state.mediaDuration = localPlayer.duration;
                el.duration.textContent = formatTime(localPlayer.duration);
                restoreAbPoints(session.pointA, session.pointB);
            };
        }).catch(function(e) {
            console.warn('ファイル復元に失敗:', e);
        });
    }
}

function restoreAbPoints(pointA, pointB) {
    if (pointA !== null && pointA !== undefined) {
        state.pointA = pointA;
        el.pointA.textContent = formatTimePrecise(pointA);
        el.btnA.classList.add('set');
    }
    if (pointB !== null && pointB !== undefined) {
        state.pointB = pointB;
        el.pointB.textContent = formatTimePrecise(pointB);
        el.btnB.classList.add('set');
    }
    updateAbBar();
    updateMarkButton();
}

function waitForYtReady(callback) {
    if (isYtReady) {
        callback();
    } else {
        var check = setInterval(function() {
            if (isYtReady) {
                clearInterval(check);
                callback();
            }
        }, 100);
        // 10秒でタイムアウト
        setTimeout(function() { clearInterval(check); }, 10000);
    }
}

// モード切替（復元用：リセットしない版）
function switchModeNoReset(mode) {
    state.mode = mode;
    document.getElementById('tab-youtube').classList.toggle('active', mode === 'youtube');
    document.getElementById('tab-local').classList.toggle('active', mode === 'local');
    document.getElementById('youtube-input-area').classList.toggle('active-area', mode === 'youtube');
    document.getElementById('local-input-area').classList.toggle('active-area', mode === 'local');
    var ytContainer = document.getElementById('youtube-player');
    if (mode === 'youtube') {
        ytContainer.style.display = 'block';
        localPlayer.style.display = 'none';
    } else {
        ytContainer.style.display = 'none';
        localPlayer.style.display = 'block';
    }
    state.isPlaying = false;
    updatePlayPauseIcon();
}

// === YouTube API ===
let ytPlayer;
let isYtReady = false;

// === DOM要素 ===
const localPlayer = document.getElementById('local-player');
const el = {
    currentTime: document.getElementById('current-time-display'),
    duration: document.getElementById('duration-display'),
    pointA: document.getElementById('point-a-display'),
    pointB: document.getElementById('point-b-display'),
    memo: document.getElementById('memo-pad'),
    speedDisplay: document.getElementById('speed-display'),
    speedSlider: document.getElementById('speed-slider'),
    loopStatus: document.getElementById('loop-status-text'),
    loopSwitch: document.getElementById('loop-switch'),
    playIcon: document.getElementById('icon-play'),
    pauseIcon: document.getElementById('icon-pause'),
    timeBarProgress: document.getElementById('time-bar-progress'),
    timeBarAb: document.getElementById('time-bar-ab'),
    mediaContainer: document.getElementById('media-container'),
    fileDropZone: document.getElementById('file-drop-zone'),
    fileName: document.getElementById('file-name'),
    btnA: document.getElementById('btn-set-a'),
    btnB: document.getElementById('btn-set-b'),
    markBtn: document.getElementById('btn-mark'),
    markLabel: document.getElementById('mark-label'),
    pointAInput: document.getElementById('point-a-input'),
    pointBInput: document.getElementById('point-b-input')
};

// === ユーティリティ ===

// 秒数を m:ss 形式にフォーマット
function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ':' + String(s).padStart(2, '0');
}

// 秒数を m:ss.ss 形式にフォーマット（精密表示用）
function formatTimePrecise(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00.00';
    const m = Math.floor(seconds / 60);
    const s = (seconds % 60).toFixed(2).padStart(5, '0');
    return m + ':' + s;
}

// 時間文字列を秒数にパース（対応形式: "90", "1:30", "1:30.5", "01:30.50"）
function parseTimeInput(str) {
    str = str.trim();
    if (!str) return NaN;

    // 数値のみ → 秒として扱う（例: "90" → 90秒）
    if (/^\d+(\.\d+)?$/.test(str)) {
        return parseFloat(str);
    }

    // m:ss または m:ss.ss 形式
    var match = str.match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/);
    if (match) {
        var minutes = parseInt(match[1], 10);
        var seconds = parseInt(match[2], 10);
        var frac = match[3] ? parseFloat('0.' + match[3]) : 0;
        if (seconds >= 60) return NaN;
        return minutes * 60 + seconds + frac;
    }

    return NaN;
}

// === YouTube IFrame API ===
function onYouTubeIframeAPIReady() {
    ytPlayer = new YT.Player('youtube-player', {
        height: '100%',
        width: '100%',
        videoId: '',
        playerVars: {
            playsinline: 1,
            rel: 0
        },
        events: {
            onReady: function() { isYtReady = true; },
            onStateChange: onYtStateChange
        }
    });
}

function onYtStateChange(event) {
    if (event.data === YT.PlayerState.PLAYING) {
        state.mediaDuration = ytPlayer.getDuration();
        el.duration.textContent = formatTime(state.mediaDuration);
        state.isPlaying = true;
        updatePlayPauseIcon();
        updateAbBar(); // セッション復元後にduration取得でABバーを表示
    } else if (event.data === YT.PlayerState.PAUSED) {
        state.isPlaying = false;
        updatePlayPauseIcon();
    } else if (event.data === YT.PlayerState.ENDED) {
        state.isPlaying = false;
        updatePlayPauseIcon();
        // 全体ループ（AB未設定時）
        if (state.isLoopEnabled && state.pointA === null && state.pointB === null) {
            ytPlayer.seekTo(0);
            ytPlayer.playVideo();
        }
    }
}

// === モード切替 ===
function switchMode(mode) {
    state.mode = mode;

    document.getElementById('tab-youtube').classList.toggle('active', mode === 'youtube');
    document.getElementById('tab-local').classList.toggle('active', mode === 'local');

    document.getElementById('youtube-input-area').classList.toggle('active-area', mode === 'youtube');
    document.getElementById('local-input-area').classList.toggle('active-area', mode === 'local');

    var ytContainer = document.getElementById('youtube-player');

    if (mode === 'youtube') {
        ytContainer.style.display = 'block';
        localPlayer.style.display = 'none';
        localPlayer.pause();
        el.mediaContainer.classList.remove('audio-mode');
    } else {
        ytContainer.style.display = 'none';
        localPlayer.style.display = 'block';
        if (isYtReady && ytPlayer && ytPlayer.pauseVideo) {
            ytPlayer.pauseVideo();
        }
    }

    state.isPlaying = false;
    updatePlayPauseIcon();
    resetDataForNewTrack();
}

function resetDataForNewTrack() {
    clearPoints();
    el.memo.value = '';
    state.mediaDuration = 0;
    el.duration.textContent = '0:00';
    el.currentTime.textContent = '0:00';
    el.timeBarProgress.style.width = '0%';
}

// === メディア読み込み ===
function loadYouTube() {
    var url = document.getElementById('youtube-url').value.trim();
    var videoId = extractYtId(url);

    if (!isYtReady) {
        alert('YouTube APIの読み込み中です。しばらく待ってから再試行してください。');
        return;
    }

    if (videoId) {
        resetDataForNewTrack();
        el.mediaContainer.classList.remove('audio-mode');
        ytPlayer.loadVideoById(videoId);
        ytPlayer.setPlaybackRate(state.speed);
        clearFileDB().catch(function() {}); // ローカルファイルデータを削除
        saveSession();
    } else {
        alert('有効なYouTube URLを入力してください。');
    }
}

function extractYtId(url) {
    var match = url.match(
        /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|shorts\/|watch\?v=|watch\?.+&v=))([A-Za-z0-9_-]{11})/
    );
    return match ? match[1] : null;
}

function loadLocalFile(event) {
    var file = event.target.files[0];
    if (!file) return;

    resetDataForNewTrack();

    // 前回のBlob URLを解放（メモリリーク防止）
    if (state.currentBlobUrl) {
        URL.revokeObjectURL(state.currentBlobUrl);
        state.currentBlobUrl = null;
    }

    var objectUrl = URL.createObjectURL(file);
    state.currentBlobUrl = objectUrl;

    // 音声ファイル判定 → コンテナサイズ調整
    var isAudio = file.type.startsWith('audio/');
    if (isAudio) {
        el.mediaContainer.classList.add('audio-mode');
    } else {
        el.mediaContainer.classList.remove('audio-mode');
    }

    // ファイル名表示
    el.fileName.textContent = file.name;

    localPlayer.src = objectUrl;
    localPlayer.load();
    localPlayer.preservesPitch = true;
    localPlayer.playbackRate = state.speed;

    // ファイルをIndexedDBに保存
    var reader = new FileReader();
    reader.onload = function() {
        saveFileToDB(reader.result, file.name, file.type).then(function() {
            saveSession();
        }).catch(function(e) {
            console.warn('ファイル保存に失敗:', e);
            saveSession();
        });
    };
    reader.readAsArrayBuffer(file);

    localPlayer.onloadedmetadata = function() {
        state.mediaDuration = localPlayer.duration;
        el.duration.textContent = formatTime(localPlayer.duration);

        // 自動再生を試みる（ブラウザポリシーで拒否される場合あり）
        localPlayer.play().then(function() {
            state.isPlaying = true;
            updatePlayPauseIcon();
        }).catch(function(err) {
            // 自動再生がブロックされた場合、ユーザーに再生ボタンを押してもらう
            console.warn('自動再生がブロックされました:', err.message);
            state.isPlaying = false;
            updatePlayPauseIcon();
        });
    };

    localPlayer.onerror = function() {
        var messages = {
            1: 'ファイルの読み込みが中断されました。',
            2: 'ネットワークエラーが発生しました。',
            3: 'ファイルのデコードに失敗しました。対応していない形式の可能性があります。',
            4: 'このファイル形式はサポートされていません。'
        };
        var code = localPlayer.error ? localPlayer.error.code : 0;
        alert(messages[code] || 'ファイルの再生中にエラーが発生しました。');
    };
}

// === ドラッグ&ドロップ ===
if (el.fileDropZone) {
    el.fileDropZone.addEventListener('dragover', function(e) {
        e.preventDefault();
        el.fileDropZone.classList.add('dragover');
    });

    el.fileDropZone.addEventListener('dragleave', function() {
        el.fileDropZone.classList.remove('dragover');
    });

    el.fileDropZone.addEventListener('drop', function(e) {
        e.preventDefault();
        el.fileDropZone.classList.remove('dragover');
        var file = e.dataTransfer.files[0];
        if (file) {
            var input = document.getElementById('local-file');
            var dt = new DataTransfer();
            dt.items.add(file);
            input.files = dt.files;
            input.dispatchEvent(new Event('change'));
        }
    });
}

// === 再生コントロール ===
function getCurrentTime() {
    if (state.mode === 'youtube' && isYtReady && ytPlayer && typeof ytPlayer.getCurrentTime === 'function') {
        return ytPlayer.getCurrentTime();
    }
    if (state.mode === 'local' && !isNaN(localPlayer.currentTime)) {
        return localPlayer.currentTime;
    }
    return 0;
}

function seekTo(time) {
    if (state.mode === 'youtube' && isYtReady && ytPlayer && ytPlayer.seekTo) {
        ytPlayer.seekTo(time, true);
    } else if (state.mode === 'local') {
        localPlayer.currentTime = time;
    }
}

function togglePlayPause() {
    if (state.mode === 'youtube') {
        if (!isYtReady || !ytPlayer) return;
        if (state.isPlaying) {
            ytPlayer.pauseVideo();
        } else {
            ytPlayer.playVideo();
        }
    } else if (state.mode === 'local') {
        if (!localPlayer.src || localPlayer.src === '') return;
        if (localPlayer.paused) {
            localPlayer.play().then(function() {
                state.isPlaying = true;
                updatePlayPauseIcon();
            }).catch(function() {});
        } else {
            localPlayer.pause();
            state.isPlaying = false;
            updatePlayPauseIcon();
        }
    }
}

function updatePlayPauseIcon() {
    el.playIcon.style.display = state.isPlaying ? 'none' : 'inline';
    el.pauseIcon.style.display = state.isPlaying ? 'inline' : 'none';
}

function skip(seconds) {
    var current = getCurrentTime();
    var duration = state.mediaDuration || Infinity;
    var target = Math.max(0, Math.min(current + seconds, duration));
    seekTo(target);
}

function seekFromBar(event) {
    if (state.mediaDuration <= 0) return;
    var rect = event.currentTarget.getBoundingClientRect();
    var ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    seekTo(ratio * state.mediaDuration);
}

// === 速度コントロール ===
function changeSpeed() {
    var newSpeed = parseFloat(el.speedSlider.value);
    applySpeed(newSpeed);
}

function setSpeed(speed) {
    el.speedSlider.value = speed;
    applySpeed(speed);
}

function applySpeed(speed) {
    state.speed = speed;
    el.speedDisplay.textContent = speed.toFixed(2) + 'x';

    if (state.mode === 'youtube' && isYtReady && ytPlayer && ytPlayer.setPlaybackRate) {
        ytPlayer.setPlaybackRate(speed);
    } else if (state.mode === 'local') {
        localPlayer.playbackRate = speed;
    }

    updateSpeedPresets();
    saveSession();
}

function updateSpeedPresets() {
    var presets = document.querySelectorAll('.speed-preset');
    for (var i = 0; i < presets.length; i++) {
        var val = parseFloat(presets[i].textContent);
        if (Math.abs(val - state.speed) < 0.01) {
            presets[i].classList.add('active');
        } else {
            presets[i].classList.remove('active');
        }
    }
}

function toggleLoop() {
    state.isLoopEnabled = el.loopSwitch.checked;
    el.loopStatus.textContent = state.isLoopEnabled ? 'ループON' : 'ループOFF';
    saveSession();
}

// === ABリピート ===

// ワンボタンでA→B順にマーク
function markPoint() {
    if (state.pointA === null) {
        setPoint('A');
    } else if (state.pointB === null) {
        setPoint('B');
    } else {
        // AB両方設定済み → クリアして再度Aから
        clearPoints();
        setPoint('A');
    }
}

function setPoint(point) {
    var currentTime = getCurrentTime();

    if (point === 'A') {
        state.pointA = currentTime;
        el.pointA.textContent = formatTimePrecise(currentTime);
        el.btnA.classList.add('set');

        // B地点がA地点以前なら解除
        if (state.pointB !== null && state.pointB <= state.pointA) {
            state.pointB = null;
            el.pointB.textContent = '--:--';
            el.btnB.classList.remove('set');
        }
    } else if (point === 'B') {
        if (state.pointA !== null && currentTime <= state.pointA) {
            alert('B地点はA地点より後に設定してください。');
            return;
        }
        state.pointB = currentTime;
        el.pointB.textContent = formatTimePrecise(currentTime);
        el.btnB.classList.add('set');
    }

    updateAbBar();
    updateMarkButton();
    saveSession();
}

function clearPoints() {
    state.pointA = null;
    state.pointB = null;
    el.pointA.textContent = '--:--';
    el.pointB.textContent = '--:--';
    if (el.btnA) el.btnA.classList.remove('set');
    if (el.btnB) el.btnB.classList.remove('set');
    updateAbBar();
    updateMarkButton();
    saveSession();
}

function updateMarkButton() {
    if (!el.markBtn) return;

    el.markBtn.classList.remove('mark-next-a', 'mark-next-b', 'mark-done');

    if (state.pointA === null) {
        el.markLabel.textContent = 'A をマーク';
        el.markBtn.classList.add('mark-next-a');
    } else if (state.pointB === null) {
        el.markLabel.textContent = 'B をマーク';
        el.markBtn.classList.add('mark-next-b');
    } else {
        el.markLabel.textContent = 'A をマーク';
        el.markBtn.classList.add('mark-done');
    }
}

// === 時間の直接入力 ===

function startEditPoint(point) {
    var display = (point === 'A') ? el.pointA : el.pointB;
    var input = (point === 'A') ? el.pointAInput : el.pointBInput;

    // 表示を隠して入力欄を出す
    display.style.display = 'none';
    input.style.display = 'inline-block';

    // 現在設定されている値があれば入力欄に入れる
    var currentVal = (point === 'A') ? state.pointA : state.pointB;
    if (currentVal !== null) {
        input.value = formatTimePrecise(currentVal);
    } else {
        input.value = '';
    }

    input.focus();
    input.select();
}

function handlePointInputKey(event, point) {
    if (event.key === 'Enter') {
        event.preventDefault();
        event.target.blur(); // blurで confirmPointInput が呼ばれる
    } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelPointInput(point);
    }
}

function confirmPointInput(point) {
    var display = (point === 'A') ? el.pointA : el.pointB;
    var input = (point === 'A') ? el.pointAInput : el.pointBInput;

    // 既に非表示なら二重処理しない（Escapeで cancel 済み）
    if (input.style.display === 'none') return;

    var rawValue = input.value.trim();

    // 入力欄を隠して表示に戻す
    input.style.display = 'none';
    display.style.display = 'inline';

    // 空欄ならキャンセル扱い
    if (!rawValue) return;

    var seconds = parseTimeInput(rawValue);
    if (isNaN(seconds) || seconds < 0) {
        alert('時間の形式が正しくありません。\n例: 90（秒）、1:30、1:30.50');
        return;
    }

    // duration を超えていたらクランプ
    if (state.mediaDuration > 0 && seconds > state.mediaDuration) {
        seconds = state.mediaDuration;
    }

    // バリデーションして設定
    if (point === 'A') {
        state.pointA = seconds;
        el.pointA.textContent = formatTimePrecise(seconds);
        el.btnA.classList.add('set');

        if (state.pointB !== null && state.pointB <= state.pointA) {
            state.pointB = null;
            el.pointB.textContent = '--:--';
            el.btnB.classList.remove('set');
        }
    } else if (point === 'B') {
        if (state.pointA !== null && seconds <= state.pointA) {
            alert('B地点はA地点（' + formatTimePrecise(state.pointA) + '）より後に設定してください。');
            return;
        }
        state.pointB = seconds;
        el.pointB.textContent = formatTimePrecise(seconds);
        el.btnB.classList.add('set');
    }

    updateAbBar();
    updateMarkButton();
    saveSession();
}

function cancelPointInput(point) {
    var display = (point === 'A') ? el.pointA : el.pointB;
    var input = (point === 'A') ? el.pointAInput : el.pointBInput;

    input.style.display = 'none';
    display.style.display = 'inline';
}

function updateAbBar() {
    if (state.pointA !== null && state.pointB !== null && state.mediaDuration > 0) {
        var left = (state.pointA / state.mediaDuration) * 100;
        var width = ((state.pointB - state.pointA) / state.mediaDuration) * 100;
        el.timeBarAb.style.left = left + '%';
        el.timeBarAb.style.width = width + '%';
        el.timeBarAb.style.display = 'block';
    } else {
        el.timeBarAb.style.display = 'none';
    }
}

// === メイン監視ループ ===
function monitorLoop() {
    var time = getCurrentTime();
    el.currentTime.textContent = formatTime(time);

    // プログレスバー更新
    if (state.mediaDuration > 0) {
        var progress = (time / state.mediaDuration) * 100;
        el.timeBarProgress.style.width = Math.min(progress, 100) + '%';
    }

    // ローカルプレーヤーの再生状態を同期
    if (state.mode === 'local') {
        var localPlaying = !localPlayer.paused && !localPlayer.ended;
        if (localPlaying !== state.isPlaying) {
            state.isPlaying = localPlaying;
            updatePlayPauseIcon();
        }
    }

    // ABリピート判定
    if (state.isLoopEnabled) {
        if (state.pointA !== null && state.pointB !== null) {
            if (time >= state.pointB) {
                seekTo(state.pointA);
            }
        }
        // ローカル全体ループ（AB未設定時）
        else if (state.mode === 'local' && state.mediaDuration > 0) {
            if (time >= state.mediaDuration - 0.1) {
                seekTo(0);
                localPlayer.play().catch(function() {});
            }
        }
    }

    requestAnimationFrame(monitorLoop);
}

// ローカルファイル終了イベント（フェイルセーフ）
localPlayer.addEventListener('ended', function() {
    if (state.isLoopEnabled && state.pointA === null && state.pointB === null) {
        seekTo(0);
        localPlayer.play().catch(function() {});
    } else {
        state.isPlaying = false;
        updatePlayPauseIcon();
    }
});

// === キーボードショートカット ===
document.addEventListener('keydown', function(e) {
    // テキスト入力中は無効
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    switch (e.code) {
        case 'Space':
            e.preventDefault();
            togglePlayPause();
            break;
        case 'ArrowLeft':
            e.preventDefault();
            skip(-5);
            break;
        case 'ArrowRight':
            e.preventDefault();
            skip(5);
            break;
        case 'KeyM':
            markPoint();
            break;
        case 'Escape':
            clearPoints();
            break;
    }
});

// メモ変更時に自動保存（入力が止まってから500ms後）
var memoSaveTimer = null;
el.memo.addEventListener('input', function() {
    clearTimeout(memoSaveTimer);
    memoSaveTimer = setTimeout(saveSession, 500);
});

// セッション復元＆監視ループ開始
restoreSession();
requestAnimationFrame(monitorLoop);

// === メモ保存 ===
function downloadMemo() {
    var memoText = el.memo.value;
    var timeA = state.pointA !== null ? formatTimePrecise(state.pointA) : '未設定';
    var timeB = state.pointB !== null ? formatTimePrecise(state.pointB) : '未設定';

    var output = '【耳コピ メモ・採譜データ】\n' +
                 '作成日時: ' + new Date().toLocaleString('ja-JP') + '\n\n' +
                 '[ABポイント]\n開始(A): ' + timeA + '\n終了(B): ' + timeB + '\n\n' +
                 '[メモ]\n' + memoText + '\n';

    var blob = new Blob([output], { type: 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'memo_' + Date.now() + '.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
