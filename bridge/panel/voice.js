const VOICE_BRIDGE = 'http://127.0.0.1:3356'

const voices = [
  'af_alloy',
  'af_aoede',
  'af_bella',
  'af_jessica',
  'af_kore',
  'af_nova',
  'af_sarah',
  'af_sky'
]

export function initVoiceCard() {
  const card = document.getElementById('voiceCard')
  const dragHandle = document.getElementById('voiceDragHandle')
  const collapseBtn = document.getElementById('voiceCollapse')
  const settingsToggleBtn = document.getElementById('voiceSettingsToggle')
  const settingsPanel = document.getElementById('voiceSettingsPanel')

  const recBtn = document.getElementById('voiceRec')
  const stopBtn = document.getElementById('voiceStop')
  const muteBtn = document.getElementById('voiceMute')
  const resetBtn = document.getElementById('voiceReset')

  const autoSpeak = document.getElementById('voiceAutoSpeak')
  const continuous = document.getElementById('voiceContinuous')
  const targetSel = document.getElementById('voiceTarget')

  const sel = document.getElementById('voiceSelect')
  const custom = document.getElementById('voiceCustom')
  const audio = document.getElementById('voiceAudio')
  const chat = document.getElementById('voiceChat')
  const status = document.getElementById('voiceStatus')
  const globalState = document.getElementById('voiceGlobalState')
  const textInput = document.getElementById('voiceTextInput')
  const textSend = document.getElementById('voiceTextSend')

  if (!card || !dragHandle || !collapseBtn || !settingsToggleBtn || !settingsPanel || !recBtn || !stopBtn || !muteBtn || !resetBtn || !autoSpeak || !continuous || !targetSel || !sel || !custom || !audio || !chat || !status || !globalState || !textInput || !textSend) return

  sel.innerHTML = voices.map(v => `<option value="${v}">${v}</option>`).join('')

  const defaultTarget = localStorage.getItem('mc_voice_target') || 'ops-bob'
  const settingsOpen = localStorage.getItem('mc_voice_settings_open') === '1'
  settingsPanel.classList.toggle('is-collapsed', !settingsOpen)
  settingsToggleBtn.textContent = settingsOpen ? '⚙ Hide Settings' : '⚙ Settings'
  settingsToggleBtn.addEventListener('click', () => {
    const next = settingsPanel.classList.contains('is-collapsed')
    settingsPanel.classList.toggle('is-collapsed', !next)
    settingsToggleBtn.textContent = next ? '⚙ Hide Settings' : '⚙ Settings'
    try { localStorage.setItem('mc_voice_settings_open', next ? '1' : '0') } catch {}
  })

  targetSel.innerHTML = [
    { id: 'ops-bob', label: 'Filippo (ops-bob)' },
    { id: 'mission-control', label: 'mission-control' }
  ].map(o => `<option value="${o.id}">${o.label}</option>`).join('')
  targetSel.value = defaultTarget

  let activeAgentId = (targetSel.value || 'ops-bob').trim()
  let sessionId = localStorage.getItem(`mc_voice_session_${activeAgentId}`) || ''

  let micMuted = localStorage.getItem('mc_voice_mic_muted') === '1'
  let busy = false
  let mediaRecorder = null
  let chunks = []

  let audioCtx = null
  let analyser = null
  let vadTimer = null

  function setStatus(msg) {
    status.textContent = msg
  }

  function setBusy(next) {
    busy = next
    recBtn.disabled = busy || !!mediaRecorder || micMuted
    stopBtn.disabled = busy || !mediaRecorder
    resetBtn.disabled = busy
    textSend.disabled = busy
    textInput.disabled = busy
  }

  function renderMute() {
    muteBtn.textContent = micMuted ? 'Mic: muted' : 'Mic: on'
    muteBtn.classList.toggle('active', !micMuted)
  }

  function appendMsg(kind, who, text, audioUrl = '') {
    const t = String(text || '').trim()
    const row = document.createElement('div')
    row.className = `voice-msg ${kind}`
    const meta = document.createElement('div')
    meta.className = 'meta'
    meta.textContent = `${new Date().toLocaleTimeString()}  ${who}`
    row.appendChild(meta)

    if (audioUrl) {
      const a = document.createElement('audio')
      a.controls = true
      a.src = audioUrl
      a.style.width = '100%'
      a.style.marginBottom = '6px'
      row.appendChild(a)
    }

    if (t) {
      const body = document.createElement('div')
      body.className = 'text'
      body.textContent = t
      row.appendChild(body)
    }

    chat.appendChild(row)
    chat.scrollTop = chat.scrollHeight
    return row
  }

  function setAgentState(state) {
    const labels = {
      idle: 'Idle',
      listen: 'Listening',
      think: 'Thinking',
      speak: 'Speaking',
      muted: 'Muted',
    }
    const normalized = labels[state] ? state : 'idle'

    const dots = document.querySelectorAll('[data-talk-dot]')
    dots.forEach((el) => {
      const id = String(el.getAttribute('data-talk-dot') || '').trim()
      el.classList.remove('idle', 'listen', 'think', 'speak', 'muted')
      el.classList.add('idle')
      if (id === activeAgentId) {
        el.classList.remove('idle')
        el.classList.add(normalized === 'muted' ? 'idle' : normalized)
      }
    })

    const stateLabels = document.querySelectorAll('[data-talk-state]')
    stateLabels.forEach((el) => {
      const id = String(el.getAttribute('data-talk-state') || '').trim()
      el.textContent = id === activeAgentId ? (labels[normalized] || 'Idle') : 'Idle'
    })

    const cards = document.querySelectorAll('.agent-card[data-agent-id]')
    cards.forEach((cardEl) => {
      const id = String(cardEl.getAttribute('data-agent-id') || '').trim()
      cardEl.classList.remove('voice-state-idle', 'voice-state-listen', 'voice-state-think', 'voice-state-speak')
      if (id === activeAgentId) cardEl.classList.add(`voice-state-${normalized === 'muted' ? 'idle' : normalized}`)
      else cardEl.classList.add('voice-state-idle')
    })

    globalState.classList.remove('idle', 'listen', 'think', 'speak', 'muted')
    globalState.classList.add(normalized)
    globalState.textContent = labels[normalized] || 'Idle'
  }

  function stopVad() {
    if (vadTimer) {
      clearInterval(vadTimer)
      vadTimer = null
    }
    if (audioCtx) {
      try { audioCtx.close() } catch {}
      audioCtx = null
      analyser = null
    }
  }

  function voiceClip(text) {
    const t = String(text || '').trim()
    if (!t) return ''
    const parts = t.split(/(?<=[.!?])\s+/)
    let out = parts.slice(0, 4).join(' ').trim()
    if (out.length > 520) out = out.slice(0, 520).trim()
    return out || t
  }

  async function speakText(text, clip = true) {
    const src = clip ? voiceClip(text) : String(text || '').trim()
    if (!src) return

    const voice = (custom.value || sel.value || 'af_alloy').trim()
    const res = await fetch(`${VOICE_BRIDGE}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: src, voice })
    })
    if (!res.ok) throw new Error(await res.text())

    const wav = await res.arrayBuffer()
    const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
    audio.src = url
    setAgentState('speak')
    try { await audio.play() } catch {}
    return url
  }

  async function sendToBrain(userText) {
    const text = String(userText || '').trim()
    if (!text) return ''

    if (!sessionId) {
      sessionId = `voice_${activeAgentId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      try { localStorage.setItem(`mc_voice_session_${activeAgentId}`, sessionId) } catch {}
    }

    setAgentState('think')
    setStatus('Thinking…')
    const pending = appendMsg('system', activeAgentId, 'Thinking…')

    const res = await fetch(`${VOICE_BRIDGE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, agentId: activeAgentId, sessionId })
    })
    if (!res.ok) throw new Error(await res.text())

    const data = await res.json()
    const reply = String(data.reply || '').trim()

    pending.remove()
    setAgentState(micMuted ? 'muted' : 'listen')
    setStatus(`Brain ok (${data.ms}ms)`)

    let spokenUrl = ''
    if (autoSpeak.checked && reply) {
      spokenUrl = await speakText(reply, true)
      setStatus('TTS ok')
      setAgentState(micMuted ? 'muted' : 'listen')
    }

    appendMsg('assistant', activeAgentId, reply, spokenUrl)
    return reply
  }

  async function recordStart(autoStop = false) {
    if (micMuted) {
      setStatus('Mic muted')
      return
    }

    setStatus('Requesting mic…')
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    chunks = []

    audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    const src = audioCtx.createMediaStreamSource(stream)
    analyser = audioCtx.createAnalyser()
    analyser.fftSize = 2048
    src.connect(analyser)

    mediaRecorder = new MediaRecorder(stream)
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data)
    }
    mediaRecorder.onstop = () => {
      try { stream.getTracks().forEach(t => t.stop()) } catch {}
      stopVad()
    }
    mediaRecorder.start()

    setAgentState('listen')
    setStatus('Recording…')
    setBusy(false)

    if (autoStop) {
      const buf = new Float32Array(analyser.fftSize)
      let speechMs = 0
      let silenceMs = 0
      const pollMs = 60
      const minSpeechMs = 300
      const endSilenceMs = 650
      const threshold = 0.018

      vadTimer = setInterval(() => {
        if (!analyser || !mediaRecorder) return
        analyser.getFloatTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
        const rms = Math.sqrt(sum / buf.length)

        if (rms >= threshold) {
          speechMs += pollMs
          silenceMs = 0
        } else {
          silenceMs += pollMs
        }

        if (speechMs >= minSpeechMs && silenceMs >= endSilenceMs) {
          void recordStopAndProcess(true)
        }
      }, pollMs)
    }
  }

  async function recordStopAndProcess(autoLoop = false) {
    if (!mediaRecorder) return

    let shouldContinue = false
    setBusy(true)
    setStatus('Stopping…')

    await new Promise((resolve) => {
      mediaRecorder.onstop = () => resolve()
      mediaRecorder.stop()
    })
    mediaRecorder = null

    try {
      setAgentState(micMuted ? 'muted' : 'listen')
      setStatus('Transcribing…')

      const blob = new Blob(chunks, { type: 'audio/webm' })
      const fd = new FormData()
      fd.append('file', blob, 'turn.webm')
      const res = await fetch(`${VOICE_BRIDGE}/asr`, { method: 'POST', body: fd })
      if (!res.ok) throw new Error(await res.text())

      const data = await res.json()
      const text = String(data.text || '').trim()
      appendMsg('you', 'You', text)
      setStatus(`ASR ok (${data.ms}ms)`)

      let brainMs = 0
      if (text) {
        const t0 = performance.now()
        await sendToBrain(text)
        brainMs = Math.round(performance.now() - t0)
      }

      if (autoLoop && continuous.checked && !micMuted) {
        shouldContinue = true
      }

      if (data?.ms || brainMs) {
        appendMsg('system', 'System', `Latency: ASR ${data?.ms ?? 'n/a'}ms · Brain ${brainMs || 'n/a'}ms`)
      }
    } catch (e) {
      setStatus(`Voice error: ${String(e).slice(0, 200)}`)
      appendMsg('system', 'System', `Error: ${String(e).slice(0, 200)}`)
      setAgentState(micMuted ? 'muted' : 'listen')
    } finally {
      setBusy(false)
      if (shouldContinue && !mediaRecorder) {
        setTimeout(() => { void recordStart(true) }, 180)
      }
    }
  }

  function resetSession() {
    sessionId = ''
    try { localStorage.removeItem(`mc_voice_session_${activeAgentId}`) } catch {}
    chat.innerHTML = ''
    setStatus('Session reset')
    setAgentState(micMuted ? 'muted' : 'listen')
  }

  recBtn.addEventListener('click', () => recordStart(false).catch(e => setStatus(`Mic error: ${e.message || e}`)))
  stopBtn.addEventListener('click', () => void recordStopAndProcess(false))

  muteBtn.addEventListener('click', () => {
    micMuted = !micMuted
    try { localStorage.setItem('mc_voice_mic_muted', micMuted ? '1' : '0') } catch {}
    renderMute()
    setStatus(micMuted ? 'Mic muted' : 'Mic on')
    setAgentState(micMuted ? 'muted' : 'listen')
  })

  resetBtn.addEventListener('click', () => resetSession())

  async function sendTypedMessage() {
    const text = String(textInput.value || '').trim()
    if (!text || busy) return
    textInput.value = ''
    appendMsg('you', 'You', text)
    setBusy(true)
    try {
      await sendToBrain(text)
    } catch (e) {
      setStatus(`Send error: ${String(e).slice(0, 180)}`)
      appendMsg('system', 'System', `Error: ${String(e).slice(0, 180)}`)
    } finally {
      setBusy(false)
      if (continuous.checked && !micMuted) {
        setTimeout(() => { if (!mediaRecorder) void recordStart(true) }, 180)
      }
    }
  }

  textSend.addEventListener('click', () => { void sendTypedMessage() })
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void sendTypedMessage()
    }
  })

  targetSel.addEventListener('change', () => {
    activeAgentId = (targetSel.value || 'ops-bob').trim()
    try { localStorage.setItem('mc_voice_target', activeAgentId) } catch {}
    sessionId = localStorage.getItem(`mc_voice_session_${activeAgentId}`) || ''
    setAgentState(micMuted ? 'muted' : 'listen')
    setStatus(`Target: ${activeAgentId}`)
  })

  collapseBtn.addEventListener('click', () => {
    card.classList.toggle('is-collapsed')
    collapseBtn.textContent = card.classList.contains('is-collapsed') ? 'Expand' : 'Collapse'
  })

  // Drag floating voice panel
  let drag = null
  dragHandle.addEventListener('mousedown', (e) => {
    if (e.target && e.target.closest && e.target.closest('button,select,input,label')) return
    const rect = card.getBoundingClientRect()
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
    document.body.style.userSelect = 'none'
  })
  window.addEventListener('mousemove', (e) => {
    if (!drag) return
    card.style.right = 'auto'
    card.style.bottom = 'auto'
    card.style.left = `${Math.max(8, e.clientX - drag.dx)}px`
    card.style.top = `${Math.max(8, e.clientY - drag.dy)}px`
  })
  window.addEventListener('mouseup', () => {
    if (!drag) return
    drag = null
    document.body.style.userSelect = ''
  })

  audio.addEventListener('ended', () => {
    setAgentState(micMuted ? 'muted' : 'listen')
    if (continuous.checked && !micMuted && !busy && !mediaRecorder) {
      setTimeout(() => { void recordStart(true) }, 140)
    }
  })

  // Agent Talk buttons: route + start turn immediately
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-talk-agent]') : null
    if (!btn) return
    const id = String(btn.getAttribute('data-talk-agent') || '').trim()
    if (!id) return

    activeAgentId = id
    targetSel.value = id
    try { localStorage.setItem('mc_voice_target', id) } catch {}
    sessionId = localStorage.getItem(`mc_voice_session_${id}`) || ''
    setStatus(`Target: ${id}`)
    setAgentState(micMuted ? 'muted' : 'listen')

    if (micMuted || busy || mediaRecorder) return
    void recordStart(true)
  })

  renderMute()
  setBusy(false)
  setAgentState(micMuted ? 'muted' : 'listen')
}
