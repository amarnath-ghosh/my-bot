'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { TranscriptionService } from '@/lib/transcription';
import { SpeechService } from '@/lib/speech';
import { AnalyticsService } from '@/lib/analytics';
import { GeminiService } from '@/lib/aiService'; 
import {
  AppState,
  TranscriptSegment,
  DeepgramResponse,
  BotResponse,
  DesktopCapturerSource,
  BotStatus 
} from '@/lib/types';

interface SpeakerMap {
  [index: number]: string;
}

export default function MeetingBotApp() {
  const [appState, setAppState] = useState<AppState>({
    meetingUrl: '',
    isInMeeting: false,
    isRecording: false,
    currentSession: null,
    status: 'System Ready',
    error: null,
  });

  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [botResponses, setBotResponses] = useState<BotResponse[]>([]);
  const [activeBots, setActiveBots] = useState<BotStatus[]>([]);
  const [lastSync, setLastSync] = useState<string>(""); 
  
  const [isControllerMode, setIsControllerMode] = useState<boolean>(false);
  const [speakerMapping, setSpeakerMapping] = useState<SpeakerMap>({});
  const [currentSentiment, setCurrentSentiment] = useState<{ emotion: string; score: number }>({ emotion: 'neutral', score: 0 });

  const [currentVisualSpeaker, setCurrentVisualSpeaker] = useState<string | null>(null);

  // Refs for services
  const fullTranscriptRef = useRef<Array<{
    speaker: string;
    text: string;
    timestamp: string;
    confidence?: number;
  }>>([]);
  const transcriptionServiceRef = useRef<TranscriptionService | null>(null);
  const speechServiceRef = useRef<SpeechService | null>(null);
  const analyticsServiceRef = useRef<AnalyticsService | null>(null);
  const geminiServiceRef = useRef<GeminiService | null>(null);

  // Refs for media
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const desktopStreamRef = useRef<MediaStream | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  
  // Refs for async control
  const audioMeterRef = useRef<NodeJS.Timeout | null>(null);
  const captureSessionRef = useRef<number>(0);
  const [sessionStartTime, setSessionStartTime] = useState<number>(0);

  // --- NEW: Ref to hold the latest transcript handler ---
  // This ensures the WebSocket always calls the freshest logic
  const transcriptHandlerRef = useRef<(segment: TranscriptSegment, data: DeepgramResponse) => Promise<void>>();

  // Sync Logic
  const syncStatus = useCallback(async () => {
    if (window.electronAPI?.getActiveBots) {
      try {
        const bots = await window.electronAPI.getActiveBots();
        setActiveBots(bots);
        setLastSync(new Date().toLocaleTimeString());
      } catch (error) {
        console.error('[UI] Failed to sync bots:', error);
      }
    }
  }, []);

  useEffect(() => {
    setLastSync(new Date().toLocaleTimeString());
    if (!window.electronAPI) return;

    syncStatus();

    const handleBotJoined = (data: BotStatus) => {
      syncStatus();
      setAppState(prev => ({ ...prev, status: `🤖 Auto-joined: ${data.id}` }));
    };

    const handleBotLeft = (meetingId: string) => {
      syncStatus();
    };

    window.electronAPI.onBotJoined(handleBotJoined);
    window.electronAPI.onBotLeft(handleBotLeft);

    if (window.electronAPI.onActiveSpeakerChange) {
      window.electronAPI.onActiveSpeakerChange((name: string) => {
        setCurrentVisualSpeaker(name);
      });
    }

    // Initialize Services
    analyticsServiceRef.current = new AnalyticsService();
    speechServiceRef.current = new SpeechService({ rate: 1.0, pitch: 1.0, volume: 0.8 });

    return () => cleanup();
  }, [syncStatus]);

  // --- TRANSCRIPT HANDLER ---
  // We define this separately and keep the Ref updated
  const handleTranscriptUpdate = async (segment: TranscriptSegment, data: DeepgramResponse) => {
      // 1. Update Speaker Mapping
      if (currentVisualSpeaker) {
          setSpeakerMapping(prev => ({
              ...prev,
              [segment.speakerIndex]: currentVisualSpeaker
          }));
      }

      const realName = speakerMapping[segment.speakerIndex] || `Speaker ${segment.speakerIndex}`;
      segment.speaker = realName;

      // 2. Analytics
      if (analyticsServiceRef.current) {
        analyticsServiceRef.current.addTranscriptSegment(segment);
        const sentiment = analyticsServiceRef.current.analyzeSentiment(segment.text);
        setCurrentSentiment({
            emotion: sentiment.overall,
            score: sentiment.score
        });
      }

      // 3. Update UI Transcript
      setTranscript((prev) => {
        const existingIndex = prev.findIndex(s => s.speakerIndex === segment.speakerIndex && !s.isFinal);
        if (data.is_final) {
          segment.isFinal = true;
          return existingIndex !== -1 ? prev.map((s, i) => i === existingIndex ? segment : s) : [...prev, segment];
        } else {
          return existingIndex !== -1 ? prev.map((s, i) => i === existingIndex ? segment : s) : [...prev, segment];
        }
      });

      // 4. Handle Finalized Text
      if (data.is_final && segment.text.trim().length > 0) {
        const newEntry = {
          speaker: realName,
          text: segment.text,
          timestamp: new Date(Date.now()).toLocaleTimeString(), // Use Date.now() for safety
          confidence: segment.confidence,
        };
        fullTranscriptRef.current = [...fullTranscriptRef.current, newEntry];

        if (isControllerMode) {
            await evaluateIntervention(segment);
        } else {
            checkForBotMention(segment);
        }
      }
  };

  // Keep the ref updated with the latest state-aware function
  useEffect(() => {
    transcriptHandlerRef.current = handleTranscriptUpdate;
  });

  const cleanup = () => {
    captureSessionRef.current += 1; // Invalidate sessions

    if (transcriptionServiceRef.current) transcriptionServiceRef.current.disconnect();
    if (speechServiceRef.current) speechServiceRef.current.stop();
    
    if (audioMeterRef.current) {
        clearInterval(audioMeterRef.current);
        audioMeterRef.current = null;
    }

    if (mediaRecorderRef.current?.state !== 'inactive') mediaRecorderRef.current?.stop();
    desktopStreamRef.current?.getTracks().forEach(t => t.stop());
    audioStreamRef.current?.getTracks().forEach(t => t.stop());
  };

  const handleMonitorBot = async (bot: BotStatus) => {
    if (appState.isRecording) {
        handleStopAnalysis();
    }

    setAppState(prev => ({
        ...prev,
        meetingUrl: bot.url,
        isInMeeting: true,
        status: `Attached to Bot (${bot.id}). Requesting audio...`,
        error: null,
        currentSession: { 
            id: bot.id, 
            url: bot.url, 
            startTime: Date.now(), 
            endTime: null, 
            participants: [], 
            totalTranscript: [] 
        } 
    }));

    if (analyticsServiceRef.current) {
        analyticsServiceRef.current.startSession(bot.id, bot.url);
    }

    await handleStartAnalysis();
  };

  const handleJoinMeeting = async () => {
    if (!appState.meetingUrl.trim()) {
      setAppState((prev) => ({ ...prev, error: 'Please enter a valid meeting URL' }));
      return;
    }

    try {
      setAppState((prev) => ({ ...prev, status: 'Joining meeting...', error: null }));

      if (window.electronAPI) {
        const result = await window.electronAPI.joinMeeting(appState.meetingUrl);
        if (result.success) {
          setAppState((prev) => ({
            ...prev,
            isInMeeting: true,
            status: 'Joined meeting. Click "Start Analysis" to begin.',
          }));
          if (analyticsServiceRef.current) {
            analyticsServiceRef.current.startSession(`session_${Date.now()}`, appState.meetingUrl);
          }
        } else {
          throw new Error('Failed to join meeting');
        }
      }
    } catch (error) {
      console.error('Error joining meeting:', error);
      setAppState((prev) => ({
        ...prev,
        error: (error as Error).message,
        status: 'Join failed',
      }));
    }
  };

  const handleStartAnalysis = async () => {
    try {
      setAppState((prev) => ({ ...prev, status: 'Initializing...', error: null }));

      const apiKey = process.env.NEXT_PUBLIC_DEEPGRAM_API_KEY;

      if (apiKey && apiKey !== 'your_deepgram_api_key_here') {
        // Disconnect existing
        if (transcriptionServiceRef.current) {
            transcriptionServiceRef.current.disconnect();
        }
        
        transcriptionServiceRef.current = new TranscriptionService({ apiKey });
        
        // Connect passing a proxy function that calls the ref
        await transcriptionServiceRef.current.connect(
          (segment, data) => {
              if (transcriptHandlerRef.current) {
                  transcriptHandlerRef.current(segment, data);
              }
          },
          handleTranscriptionError
        );
      } else {
        setAppState((prev) => ({
          ...prev,
          status: 'Running in demo mode (no real transcription).',
        }));
      }

      const geminiApiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
      if (geminiApiKey && geminiApiKey !== 'your_gemini_api_key_here') {
        geminiServiceRef.current = new GeminiService();
      }

      await startAudioCapture();
      setSessionStartTime(Date.now());

      setAppState((prev) => ({
        ...prev,
        isRecording: true,
        status: isControllerMode ? 'AI Controller Active: Analyzing & Intervening...' : 'Passive Recording...',
      }));
    } catch (error) {
      setAppState((prev) => ({
        ...prev,
        error: `Failed to start analysis: ${(error as Error).message}`,
        status: 'Analysis failed',
        isRecording: false,
      }));
    }
  };

  const startAudioCapture = async () => {
    // 1. Session ID Check
    const currentSessionId = captureSessionRef.current + 1;
    captureSessionRef.current = currentSessionId;

    // 2. Cleanup
    if (audioMeterRef.current) {
        clearInterval(audioMeterRef.current);
        audioMeterRef.current = null;
    }
    if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach(t => t.stop());
    }
    if (desktopStreamRef.current) {
        desktopStreamRef.current.getTracks().forEach(t => t.stop());
    }

    let transcriptionAudioStream: MediaStream | null = null;

    if (window.electronAPI) {
        try {
            console.log('[Audio] Attempting silent desktop capture...');
            const sources = await window.electronAPI.getSources();
            const entireScreenSource = sources.find((source: DesktopCapturerSource) => source.id.startsWith('screen:'));
            
            if (entireScreenSource) {
                const constraints = {
                    audio: {
                        mandatory: {
                            chromeMediaSource: 'desktop',
                            chromeMediaSourceId: entireScreenSource.id,
                        },
                    },
                    video: {
                        mandatory: {
                            chromeMediaSource: 'desktop',
                            chromeMediaSourceId: entireScreenSource.id,
                        },
                    },
                };
                
                // @ts-ignore
                const stream = await navigator.mediaDevices.getUserMedia(constraints);
                
                if (stream.getAudioTracks().length > 0) {
                    console.log('[Audio] Silent capture successful.');
                    transcriptionAudioStream = new MediaStream(stream.getAudioTracks());
                    desktopStreamRef.current = stream;
                } else {
                    console.warn('[Audio] Silent capture returned NO audio tracks.');
                    stream.getTracks().forEach(t => t.stop());
                }
            }
        } catch (e) {
            console.warn('[Audio] Silent capture failed:', e);
        }
    }

    if (!transcriptionAudioStream) {
        if (captureSessionRef.current !== currentSessionId) return; // Abort if stale

        console.log('[Audio] Falling back to interactive picker.');
        setAppState(prev => ({...prev, status: '⚠️ ACTION REQUIRED: Select Screen & Check "Share System Audio"'}));
        
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({ 
                video: true, 
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            });
            
            if (stream.getAudioTracks().length > 0) {
                transcriptionAudioStream = new MediaStream(stream.getAudioTracks());
                desktopStreamRef.current = stream;
            } else {
                stream.getTracks().forEach(t => t.stop());
                throw new Error("You selected a screen but did not check 'Share System Audio'.");
            }
        } catch (err) {
            console.error('[Audio] Picker capture failed:', err);
            throw new Error(`Audio capture failed: ${(err as Error).message}`);
        }
    }

    // 3. Final Session Check
    if (captureSessionRef.current !== currentSessionId) {
        console.log(`[Audio] Setup cancelled for session ${currentSessionId}.`);
        transcriptionAudioStream?.getTracks().forEach(t => t.stop());
        return; 
    }

    // 4. Start Recording
    if (transcriptionAudioStream) {
        audioStreamRef.current = transcriptionAudioStream;
        
        try {
            const audioContext = new AudioContext();
            const source = audioContext.createMediaStreamSource(transcriptionAudioStream);
            const analyzer = audioContext.createAnalyser();
            source.connect(analyzer);
            const dataArray = new Uint8Array(analyzer.frequencyBinCount);
            
            const intervalId = setInterval(() => {
                if (captureSessionRef.current !== currentSessionId) {
                    clearInterval(intervalId);
                    return;
                }
                analyzer.getByteFrequencyData(dataArray);
                const volume = dataArray.reduce((a, b) => a + b) / dataArray.length;
                if (volume > 0) console.log(`[AudioMonitor] 🔊 Volume: ${volume.toFixed(1)}`);
            }, 3000);
            
            audioMeterRef.current = intervalId;

        } catch(e) { console.warn("Audio meter failed", e); }

        const mediaRecorder = new MediaRecorder(transcriptionAudioStream, { mimeType: 'audio/webm' });
        mediaRecorderRef.current = mediaRecorder;

        mediaRecorder.ondataavailable = async (event: BlobEvent) => {
            if (captureSessionRef.current !== currentSessionId) return;

            if (event.data && event.data.size > 0 && transcriptionServiceRef.current?.isWebSocketConnected()) {
                const arrayBuffer = await event.data.arrayBuffer();
                transcriptionServiceRef.current.sendAudio(arrayBuffer);
            }
        };

        mediaRecorder.start(250); 
        console.log('[Audio] MediaRecorder started.');
    }
  };

  const evaluateIntervention = async (segment: TranscriptSegment) => {
    if (!geminiServiceRef.current) return;
    if (segment.speaker === 'Bot') return;

    try {
        const isQuestion = segment.text.includes('?') || segment.text.toLowerCase().includes('bot');
        if (isQuestion) {
             handleBotResponse(segment.text, true); 
        }
    } catch (e) {
        console.error("Controller logic failed", e);
    }
  };

  const checkForBotMention = (segment: TranscriptSegment): void => {
    const text = segment.text.toLowerCase();
    const botTriggers = ['bot', 'assistant', 'ai', 'hey bot', 'hello board'];
    if (botTriggers.some(trigger => text.includes(trigger))) {
      handleBotResponse(segment.text);
    }
  };

  const handleBotResponse = async (userMessage: string, isProactive: boolean = false) => {
    if (!geminiServiceRef.current) return;

    try {
      const thinkingMessage: BotResponse = {
        speaker: 'Bot',
        text: isProactive ? '🤖 Intervening...' : 'Thinking...',
        timestamp: Date.now(),
      };
      setBotResponses((prev) => [...prev, thinkingMessage]);

      const responseText = await geminiServiceRef.current.generateResponse(
          userMessage, 
          fullTranscriptRef.current
      );

      const newResponse: BotResponse = {
        speaker: 'Bot',
        text: responseText,
        timestamp: Date.now(),
      };

      setBotResponses((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = newResponse;
        return updated;
      });

      if (speechServiceRef.current && window.electronAPI) {
        const rawPCMBuffer = await speechServiceRef.current.createAudioData(responseText);
        const pcmData = convertInt16ToFloat32(rawPCMBuffer);
        window.electronAPI.sendBotAudio(pcmData);
      }

    } catch (error) {
      console.error('Error in handleBotResponse:', error);
    }
  };

  const handleTranscriptionError = (error: Error) => {
    setAppState((prev) => ({ ...prev, error: `Transcription error: ${error.message}` }));
  };

  const handleStopAnalysis = () => {
    captureSessionRef.current += 1; // Invalidate session

    if (audioMeterRef.current) {
        clearInterval(audioMeterRef.current);
        audioMeterRef.current = null;
    }
    mediaRecorderRef.current?.stop();
    desktopStreamRef.current?.getTracks().forEach(t => t.stop());
    transcriptionServiceRef.current?.disconnect();
    setAppState((prev) => ({ ...prev, isRecording: false, status: 'Analysis stopped' }));
  };

  const handleLeaveMeeting = async (id?: string) => {
    const isMonitoringCurrentSession = !id || (id && appState.currentSession?.id === id);

    if (isMonitoringCurrentSession) {
        handleStopAnalysis();

        if (analyticsServiceRef.current) {
            const sessionData = analyticsServiceRef.current.endSession();
            if (sessionData) {
                const filename = `meeting-${sessionData.id || 'report'}-${new Date().toISOString().slice(0, 10)}`;
                analyticsServiceRef.current.downloadExport(filename, {
                    format: 'json',
                    includeTranscript: true,
                    includeSentiment: true,
                    includeWordTiming: false
                });
            }
        }
        
        setAppState((prev) => ({ ...prev, isInMeeting: false, currentSession: null }));
    }

    if (window.electronAPI) {
        await window.electronAPI.closeMeeting(id);
    }
  };

  const convertInt16ToFloat32 = (buffer: ArrayBuffer): Float32Array => {
    const int16Array = new Int16Array(buffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768; 
    }
    return float32Array;
  };

  const updateSpeakerName = (index: number, name: string) => {
    setSpeakerMapping(prev => ({...prev, [index]: name}));
  };

  return (
    <div className="min-h-screen bg-gray-100 font-sans text-gray-900">
      <div className="container mx-auto px-4 py-8 max-w-6xl">
        <header className="flex justify-between items-center mb-8 bg-white p-6 rounded-2xl shadow-sm border border-gray-200">
          <div>
            <h1 className="text-3xl font-bold text-indigo-700">AI Fleet Commander</h1>
            <p className="text-gray-500 text-sm mt-1">
                {isControllerMode ? "🤖 CONTROLLER MODE ACTIVE" : "🎧 PASSIVE LISTENER MODE"}
            </p>
          </div>
          <div className="flex gap-4">
             <button 
                onClick={() => setIsControllerMode(!isControllerMode)}
                className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${isControllerMode ? 'bg-red-100 text-red-600 border border-red-200' : 'bg-gray-100 text-gray-600'}`}
             >
                {isControllerMode ? 'Disable Auto-Pilot' : 'Enable Auto-Pilot'}
             </button>
          </div>
        </header>

        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 mb-6">
            <div className="flex justify-between items-center mb-4">
                <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Active Deployments ({activeBots.length})</h3>
                <button onClick={syncStatus} className="text-xs text-indigo-600">Sync ({lastSync})</button>
            </div>
            <div className="flex flex-wrap gap-4">
                {activeBots.length === 0 && <p className="text-gray-400 text-sm">No active bots.</p>}
                {activeBots.map((bot) => (
                    <div key={bot.id} className="flex items-center gap-3 p-3 border rounded-lg bg-indigo-50">
                        <div className="h-3 w-3 rounded-full bg-green-500 animate-pulse"></div>
                        <div className="text-sm">
                            <p className="font-bold text-indigo-900">{bot.id}</p>
                            <button onClick={() => handleMonitorBot(bot)} className="text-xs text-indigo-600 hover:underline">Monitor</button>
                            <span className="mx-2">|</span>
                            <button onClick={() => handleLeaveMeeting(bot.id)} className="text-xs text-red-600 hover:underline">Terminate</button>
                        </div>
                    </div>
                ))}
            </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
          <div className="flex flex-col md:flex-row gap-4">
             <input
                type="url"
                value={appState.meetingUrl}
                onChange={(e) => setAppState((prev) => ({ ...prev, meetingUrl: e.target.value }))}
                placeholder="Enter Meeting URL..."
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm"
                disabled={appState.isInMeeting}
              />
              {!appState.isInMeeting ? (
                  <button onClick={handleJoinMeeting} className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium">
                      Join Meeting
                  </button>
              ) : (
                  <>
                    <button onClick={handleStartAnalysis} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">Start Analysis</button>
                    <button onClick={() => handleLeaveMeeting()} className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700">Leave</button>
                  </>
              )}
          </div>
          <p className="text-xs text-gray-400 mt-2">Status: {appState.status}</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
             <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 min-h-[400px] col-span-2 flex flex-col">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Live Transcript</h3>
                    <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-gray-50 border">
                        <span className="text-xs text-gray-500">Tone:</span>
                        <span className={`text-xs font-bold ${
                            currentSentiment.emotion === 'positive' ? 'text-green-600' : 
                            currentSentiment.emotion === 'negative' ? 'text-red-600' : 'text-gray-600'
                        }`}>
                            {currentSentiment.emotion.toUpperCase()} ({Math.round(Math.abs(currentSentiment.score) * 100)}%)
                        </span>
                    </div>
                </div>
                
                <div className="flex-1 overflow-y-auto space-y-4 max-h-[500px] pr-2">
                    {transcript.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-gray-400 text-sm border-2 border-dashed rounded-lg">
                            <p>Waiting for audio...</p>
                        </div>
                    ) : (
                        transcript.map((t, i) => (
                            <div key={i} className="flex gap-3 group">
                                <div className="flex-shrink-0 flex flex-col items-center gap-1">
                                    <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-xs font-bold text-indigo-700">
                                        {t.speakerIndex}
                                    </div>
                                    <input 
                                        type="text" 
                                        placeholder="Name"
                                        className="w-16 text-[10px] text-center border border-transparent hover:border-gray-300 rounded bg-transparent focus:bg-white transition-all"
                                        defaultValue={speakerMapping[t.speakerIndex] || ''}
                                        onBlur={(e) => updateSpeakerName(t.speakerIndex, e.target.value)}
                                    />
                                </div>
                                <div className="flex-1">
                                    <div className="flex items-baseline gap-2 mb-1">
                                        <span className="text-xs font-bold text-gray-700">
                                            {speakerMapping[t.speakerIndex] || t.speaker}
                                        </span>
                                        <span className="text-[10px] text-gray-400">
                                            {new Date(t.startTime).toLocaleTimeString()}
                                        </span>
                                    </div>
                                    <p className={`text-sm p-3 rounded-lg ${t.isFinal ? 'bg-gray-50 text-gray-800' : 'bg-gray-50/50 text-gray-400 italic'}`}>
                                        {t.text}
                                    </p>
                                </div>
                            </div>
                        ))
                    )}
                </div>
             </div>

             <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 min-h-[400px] flex flex-col">
                <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Bot Actions</h3>
                <div className="flex-1 overflow-y-auto space-y-3 max-h-[500px]">
                    {botResponses.map((response, index) => (
                        <div key={index} className="bg-indigo-50 border border-indigo-100 rounded-lg p-3">
                            <div className="flex items-center mb-1 gap-2">
                                <span className="text-xs font-bold text-indigo-700 uppercase">BOT</span>
                                <span className="text-[10px] text-indigo-400">{new Date(response.timestamp).toLocaleTimeString()}</span>
                            </div>
                            <p className="text-sm text-indigo-900">{response.text}</p>
                        </div>
                    ))}
                </div>
                
                <div className="mt-4 pt-4 border-t">
                    <button 
                        onClick={() => handleBotResponse("Summarize the meeting so far.")}
                        className="w-full py-2 bg-gray-100 text-gray-700 text-xs font-bold rounded hover:bg-gray-200 mb-2"
                    >
                        Request Summary
                    </button>
                </div>
             </div>
        </div>
      </div>
    </div>
  );
}