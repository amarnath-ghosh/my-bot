'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { TranscriptionService } from '@/lib/transcription';
import { SpeechService } from '@/lib/speech';
import { AnalyticsService } from '@/lib/analytics';
import { GeminiService } from '@/lib/aiService'; 
import {
  AppState,
  TranscriptSegment,
  AudioCaptureSettings,
  DeepgramResponse,
  BotResponse,
  DesktopCapturerSource,
  BotStatus 
} from '@/lib/types';

export default function MeetingBotApp() {
  // --- 1. STATE DEFINITIONS ---
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
  
  // Track auto-joined bots
  const [activeBots, setActiveBots] = useState<BotStatus[]>([]);
  
  // FIX: Initialize with empty string to prevent Server/Client mismatch
  const [lastSync, setLastSync] = useState<string>(""); 
  
  // Ref for transcript context
  const fullTranscriptRef = useRef<Array<{
    speaker: string;
    text: string;
    timestamp: string;
    confidence?: number;
  }>>([]);
  
  const [sessionStartTime, setSessionStartTime] = useState<number>(0);

  // --- 2. SERVICE REFS ---
  const transcriptionServiceRef = useRef<TranscriptionService | null>(null);
  const speechServiceRef = useRef<SpeechService | null>(null);
  const analyticsServiceRef = useRef<AnalyticsService | null>(null);
  const geminiServiceRef = useRef<GeminiService | null>(null);

  // --- 3. MEDIA REFS ---
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const desktopStreamRef = useRef<MediaStream | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);

  // --- 4. SERVER CONFIG (For Display) ---
  const serverUrl = process.env.NEXT_PUBLIC_BBB_EMPLOYABILITY_API_URL || 'Unknown Server';

  // --- 5. EFFECTS ---

  // Improved Sync Function to fetch latest state from Main Process
  const syncStatus = useCallback(async () => {
    if (window.electronAPI?.getActiveBots) {
      try {
        const bots = await window.electronAPI.getActiveBots();
        console.log('[UI] Syncing active bots:', bots);
        setActiveBots(bots);
        setLastSync(new Date().toLocaleTimeString());
      } catch (error) {
        console.error('[UI] Failed to sync bots:', error);
      }
    }
  }, []);

  useEffect(() => {
    // FIX: Set initial time only on the client side
    setLastSync(new Date().toLocaleTimeString());

    if (!window.electronAPI) return;

    // 1. Initial Sync: Ask backend "Are any bots running?"
    syncStatus();

    // 2. Listen for New Joins
    window.electronAPI.onBotJoined((data: BotStatus) => {
      console.log('[UI] 🚨 New meeting joined:', data);
      syncStatus(); // Force a full sync to ensure list is accurate
      setAppState(prev => ({ ...prev, status: `🚀 Auto-joined: ${data.id}` }));
    });

    // 3. Listen for Leavings
    window.electronAPI.onBotLeft((meetingId: string) => {
      console.log('[UI] Bot left:', meetingId);
      syncStatus(); // Force a full sync
    });

    // Initialize Services
    const initializeServices = async () => {
      try {
        analyticsServiceRef.current = new AnalyticsService();
        speechServiceRef.current = new SpeechService({ rate: 1.0, pitch: 1.0, volume: 0.8 });
      } catch (error) {
        console.error('Failed to initialize services:', error);
      }
    };
    initializeServices();

    return () => cleanup();
  }, [syncStatus]);

  const cleanup = useCallback((): void => {
    if (transcriptionServiceRef.current) transcriptionServiceRef.current.disconnect();
    if (speechServiceRef.current) speechServiceRef.current.stop();
    if (mediaRecorderRef.current?.state !== 'inactive') mediaRecorderRef.current?.stop();
    desktopStreamRef.current?.getTracks().forEach(t => t.stop());
    audioStreamRef.current?.getTracks().forEach(t => t.stop());
  }, []);

  // --- 6. HANDLERS ---

  // NEW: Handle attaching to an existing background bot
  const handleMonitorBot = async (bot: BotStatus) => {
    console.log(`[UI] Attaching to bot: ${bot.id}`);

    // 1. Stop any existing local analysis first
    if (appState.isRecording) {
        handleStopAnalysis();
    }

    // 2. Update UI State to reflect we are "in" this meeting
    setAppState(prev => ({
        ...prev,
        meetingUrl: bot.url,
        isInMeeting: true, // The bot is physically there, so we are logically there
        status: `Attached to Bot (${bot.id}). Requesting audio...`,
        error: null,
        // Mock session object to make UI indicators light up
        currentSession: { 
            id: bot.id, 
            url: bot.url, 
            startTime: Date.now(), 
            endTime: null, 
            participants: [], 
            totalTranscript: [] 
        } 
    }));

    // 3. Initialize Analytics for this specific session
    if (analyticsServiceRef.current) {
        analyticsServiceRef.current.startSession(bot.id, bot.url);
    }

    // 4. Start Transcription/AI immediately
    // Note: This will trigger the screen share prompt. 
    // User must select "System Audio" to hear the hidden window.
    await handleStartAnalysis();
  };

  const handleJoinMeeting = async (): Promise<void> => {
    if (!appState.meetingUrl.trim()) {
      setAppState((prev: AppState) => ({ ...prev, error: 'Please enter a valid meeting URL' }));
      return;
    }

    try {
      setAppState((prev: AppState) => ({ ...prev, status: 'Joining meeting...', error: null }));

      if (window.electronAPI) {
        const result = await window.electronAPI.joinMeeting(appState.meetingUrl);
        if (result.success) {
          setAppState((prev: AppState) => ({
            ...prev,
            isInMeeting: true,
            status: 'Joined meeting. Click "Start Analysis" to begin recording and analysis.',
          }));
          if (analyticsServiceRef.current) {
            const sessionId = `session_${Date.now()}`;
            analyticsServiceRef.current.startSession(sessionId, appState.meetingUrl);
          }
        } else {
          throw new Error('Failed to join meeting');
        }
      } else {
        window.open(appState.meetingUrl, '_blank', 'width=1024,height=768');
        setAppState((prev: AppState) => ({
          ...prev,
          isInMeeting: true,
          status: 'Meeting opened in new tab. Click "Start Analysis" when ready.',
        }));
        if (analyticsServiceRef.current) {
          const sessionId = `session_${Date.now()}`;
          analyticsServiceRef.current.startSession(sessionId, appState.meetingUrl);
        }
      }
    } catch (error) {
      console.error('Error joining meeting:', error);
      setAppState((prev: AppState) => ({
        ...prev,
        error: (error as Error).message,
        status: 'Join failed',
      }));
    }
  };

  const handleStartAnalysis = async (): Promise<void> => {
    try {
      setAppState((prev: AppState) => ({ ...prev, status: 'Initializing...', error: null }));

      const apiKey = process.env.NEXT_PUBLIC_DEEPGRAM_API_KEY;

      if (apiKey && apiKey !== 'your_deepgram_api_key_here') {
        console.log('Deepgram API key found, initializing transcription service...');
        transcriptionServiceRef.current = new TranscriptionService({ apiKey });

        await transcriptionServiceRef.current.connect(
          handleTranscriptUpdate,
          handleTranscriptionError
        );
        console.log('✓ Connected to Deepgram');
      } else {
        console.warn('⚠ No Deepgram API key configured. Running in mock mode.');
        setAppState((prev: AppState) => ({
          ...prev,
          status: 'Running in demo mode (no real transcription). Add Deepgram API key for real-time transcription.',
        }));
      }

      const geminiApiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
      if (geminiApiKey && geminiApiKey !== 'your_gemini_api_key_here') {
        geminiServiceRef.current = new GeminiService();
        console.log('✓ GeminiService initialized');
      } else {
        console.warn('⚠ No Gemini API key found. Bot responses will be disabled.');
      }

      await startAudioCapture();
      
      setSessionStartTime(Date.now());

      setAppState((prev: AppState) => ({
        ...prev,
        isRecording: true,
        status: apiKey
          ? 'Recording and analyzing with Deepgram...'
          : 'Recording with mock transcription...',
      }));
    } catch (error) {
      console.error('Error starting analysis:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      setAppState((prev: AppState) => ({
        ...prev,
        error: `Failed to start analysis: ${errorMessage}`,
        status: 'Analysis failed to start',
        isRecording: false,
      }));
    }
  };

  const startAudioCapture = async (): Promise<void> => {
    let transcriptionAudioStream: MediaStream;

    try {
      if (window.electronAPI) {
        console.log('Electron API found. Using desktopCapturer.');
        setAppState((prev: AppState) => ({ ...prev, status: 'Getting audio sources...' }));

        const sources = await window.electronAPI.getSources();
        const entireScreenSource = sources.find((source: DesktopCapturerSource) => source.id.startsWith('screen:'));
        
        if (!entireScreenSource) {
          throw new Error("Could not find a screen to capture.");
        }

        console.log('Capturing source:', entireScreenSource.name);

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
        const fullDesktopStream = await navigator.mediaDevices.getUserMedia(constraints);
        desktopStreamRef.current = fullDesktopStream;
        transcriptionAudioStream = new MediaStream(fullDesktopStream.getAudioTracks());
        
      } else {
        console.log('No Electron API found. Falling back to getDisplayMedia.');
        setAppState((prev: AppState) => ({ ...prev, status: 'Requesting permission. IMPORTANT: Please check "Share tab audio" or "Share system audio" to capture all participants.' }));
        
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });

        desktopStreamRef.current = displayStream;

        const hasAudio = displayStream.getAudioTracks().length > 0;
        if (!hasAudio) {
          throw new Error('No audio available. Please enable "Share audio" when selecting screen.');
        }
        transcriptionAudioStream = new MediaStream(displayStream.getAudioTracks());
      }

      // --- 🚨 CRITICAL FIX: CHECK FOR AUDIO TRACKS ---
      const audioTracks = transcriptionAudioStream.getAudioTracks();
      if (audioTracks.length === 0) {
        alert("CRITICAL ERROR: No audio track detected.\n\nWhen the screen share popup appears, you MUST check the box 'Share System Audio' (bottom left).");
        throw new Error("No audio track in stream. User likely did not share system audio.");
      }

      // Debug: Monitor audio levels
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(transcriptionAudioStream);
      const analyzer = audioContext.createAnalyser();
      source.connect(analyzer);
      const dataArray = new Uint8Array(analyzer.frequencyBinCount);
      
      // Simple loop to log if we are actually "hearing" anything
      const checkAudioInterval = setInterval(() => {
        analyzer.getByteFrequencyData(dataArray);
        const volume = dataArray.reduce((a, b) => a + b) / dataArray.length;
        if (volume > 0) {
            console.log(`[AudioMonitor] 🔊 Hearing Audio (Vol: ${volume.toFixed(1)})`);
            clearInterval(checkAudioInterval); // Stop checking once we confirm audio
        }
      }, 1000);
      
      audioStreamRef.current = transcriptionAudioStream;
      console.log('✓ Audio stream obtained for transcription.');
      
      const supportedTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/wav',
        'audio/mp4',
      ];

      let selectedType = '';
      for (const type of supportedTypes) {
        if (MediaRecorder.isTypeSupported(type)) {
          selectedType = type;
          console.log(`✓ Supported MIME type found: ${type}`);
          break;
        }
      }

      if (!selectedType) {
        console.warn('No specific MIME type supported, using browser default.');
      }
      
      const options: MediaRecorderOptions = selectedType ? { mimeType: selectedType } : {};
      const mediaRecorder = new MediaRecorder(transcriptionAudioStream, options);
      console.log(`MediaRecorder initialized with type: ${mediaRecorder.mimeType || 'default'}`);
      
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = async (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          await processAudioChunk(event.data);
        }
      };

      mediaRecorder.onerror = (event: Event) => {
        console.error('MediaRecorder error:', event);
        setAppState((prev: AppState) => ({
          ...prev,
          error: 'Recording error occurred. Please try again.',
          status: 'Recording failed'
        }));
      };

      mediaRecorder.onstart = () => {
        console.log('✓ MediaRecorder started successfully');
        setAppState((prev: AppState) => ({ 
          ...prev, 
          status: 'Recording and analyzing meeting audio...' 
        }));
      };

      mediaRecorder.onstop = () => {
        console.log('MediaRecorder stopped');
        if (appState.isRecording) {
            console.warn("MediaRecorder stopped unexpectedly. Restarting capture...");
            startAudioCapture().catch(err => {
                console.error("Failed to restart audio capture:", err);
                setAppState((prev: AppState) => ({...prev, error: "Audio capture failed and could not be restarted."}));
            });
        }
      };

      mediaRecorder.start(1000);

    } catch (error) {
      console.error('Full error in startAudioCapture:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to start audio capture: ${errorMessage}`);
    }
  };

 const processAudioChunk = async (audioBlob: Blob): Promise<void> => {
    try {
      if (transcriptionServiceRef.current?.isWebSocketConnected()) {
        const arrayBuffer = await audioBlob.arrayBuffer();
        transcriptionServiceRef.current.sendAudio(arrayBuffer);
      } else if (!transcriptionServiceRef.current) {
        // Mock transcription logic
        if (Math.random() > 0.9) { 
          const mockTexts = [ 'Hello bot, can you summarize?', 'I have a question for the bot.' ];
          const mockSegment: TranscriptSegment = {
            speaker: `Speaker ${Math.floor(Math.random() * 2)}`,
            speakerIndex: Math.floor(Math.random() * 2),
            text: mockTexts[Math.floor(Math.random() * mockTexts.length)],
            startTime: (Date.now() - sessionStartTime) / 1000,
            endTime: (Date.now() - sessionStartTime) / 1000 + 2,
            confidence: 0.95,
            isFinal: true,
          };
          const mockData: DeepgramResponse = {
            is_final: true, speech_final: true,
            channel: { alternatives: [{ transcript: mockSegment.text, confidence: mockSegment.confidence, words: [] }] },
            metadata: { request_id: '', model_info: { name: 'mock', version: '1.0' } },
          };
          handleTranscriptUpdate(mockSegment, mockData);
        }
      }
    } catch (error) {
      console.error('Error processing audio chunk:', error);
    }
  };

  const handleTranscriptUpdate = useCallback(
    (segment: TranscriptSegment, data: DeepgramResponse): void => {
      console.log('Transcript:', segment.text, 'Is Final:', data.is_final);

      if (analyticsServiceRef.current) {
        analyticsServiceRef.current.addTranscriptSegment(segment);
        const sentiment = analyticsServiceRef.current.analyzeSentiment(segment.text);
        analyticsServiceRef.current.updateParticipantSentiment(
          `unknown_${segment.speakerIndex}`,
          sentiment
        );
      }

      setTranscript((prev: TranscriptSegment[]) => {
        const existingIndex = prev.findIndex(
          s => s.speakerIndex === segment.speakerIndex && !s.isFinal
        );

        if (data.is_final) {
          segment.isFinal = true;
          if (existingIndex !== -1) {
            const updated = [...prev];
            updated[existingIndex] = segment;
            return updated;
          } else {
            return [...prev, segment];
          }
        } else {
          if (existingIndex !== -1) {
            const updated = [...prev];
            updated[existingIndex] = segment;
            return updated;
          } else {
            return [...prev, segment];
          }
        }
      });

      if (data.is_final && segment.text.trim().length > 0) {
        try {
          const entryTimestamp = new Date(sessionStartTime + segment.startTime * 1000).toLocaleTimeString();
          const newEntry = {
            speaker: segment.speaker || `Speaker ${segment.speakerIndex}`,
            text: segment.text,
            timestamp: entryTimestamp,
            confidence: segment.confidence,
          };
          try {
            fullTranscriptRef.current = [...fullTranscriptRef.current, newEntry];
          } catch (e) {}
        } catch (err) {
          console.warn('Failed to append to fullTranscript:', err);
        }

        checkForBotMention(segment);
      }
    },
    [sessionStartTime] 
  );

  const handleTranscriptionError = useCallback((error: Error): void => {
    console.error('Transcription error:', error);
    setAppState((prev: AppState) => ({
      ...prev,
      error: `Transcription error: ${error.message}`,
      status: 'Transcription failed',
    }));
  }, []);

  const checkForBotMention = (segment: TranscriptSegment): void => {
    const text = segment.text.toLowerCase();
    const botTriggers = ['bot', 'assistant', 'ai', 'hey bot', 'bot please', 'hello board', 'hello bob'];
    
    if (botTriggers.some(trigger => text.includes(trigger))) {
      handleBotResponse(segment);
    }
  };

  const handleBotResponse = async (input: TranscriptSegment | string): Promise<void> => {
    if (!geminiServiceRef.current) {
      console.warn('Gemini service not initialized. Skipping bot response.');
      return;
    }

    const userMessage = typeof input === 'string' ? input : input.text;
    const lower = userMessage.toLowerCase();
    
    // Safety check against feedback loops
    if (lower.includes("i'm sorry, i encountered an error") || lower.includes('i am sorry, i encountered an error')) {
      return;
    }
    if (lower.includes('gemini') || lower.includes('flash')) {
      return;
    }

    try {
      const thinkingMessage: BotResponse = {
        speaker: 'Bot',
        text: '...',
        timestamp: Date.now(),
      };
      setBotResponses((prev: BotResponse[]) => [...prev, thinkingMessage]);

      const currentTranscript = fullTranscriptRef.current || [];
      let responseText: string;

      if (userMessage.toLowerCase().includes('summarize')) {
        responseText = await geminiServiceRef.current.summarizeMeeting(currentTranscript);
      } else {
        responseText = await geminiServiceRef.current.generateResponse(userMessage, currentTranscript);
      }

      const newResponse: BotResponse = {
        speaker: 'Bot',
        text: responseText,
        timestamp: Date.now(),
      };

      setBotResponses((prev: BotResponse[]) => {
        const updated = [...prev];
        const lastResponse = updated[updated.length - 1];
        if (lastResponse && lastResponse.text === '...') {
          updated[updated.length - 1] = newResponse;
        } else {
          updated.push(newResponse);
        }
        return updated;
      });

      if (speechServiceRef.current && window.electronAPI) {
        try {
          const rawPCMBuffer: ArrayBuffer = await speechServiceRef.current.createAudioData(responseText);
          const pcmData: Float32Array = convertInt16ToFloat32(rawPCMBuffer);
          window.electronAPI.sendBotAudio(pcmData);
        } catch (audioError) {
          console.error('Failed to generate or send bot audio:', audioError);
        }
      }

    } catch (error) {
      console.error('Error in handleBotResponse:', error);
      setBotResponses((prev: BotResponse[]) => {
        const updated = [...prev];
        const lastResponse = updated[updated.length - 1];
        if (lastResponse && lastResponse.text === '...') {
          lastResponse.text = 'Sorry, I had trouble responding.';
        }
        return updated;
      });
    }
  };

  const handleStopAnalysis = (): void => {
    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      if (desktopStreamRef.current) {
        desktopStreamRef.current.getTracks().forEach(track => track.stop());
        desktopStreamRef.current = null;
      }
      if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach(track => track.stop());
        audioStreamRef.current = null;
      }
      if (transcriptionServiceRef.current) {
        transcriptionServiceRef.current.disconnect();
      }
      
      setSessionStartTime(0);

      setAppState((prev: AppState) => ({
        ...prev,
        isRecording: false,
        status: 'Analysis stopped'
      }));

    } catch (error) {
      console.error('Error stopping analysis:', error);
      setAppState((prev: AppState) => ({
        ...prev,
        error: (error as Error).message
      }));
    }
  };

  const handleLeaveMeeting = async (id?: string): Promise<void> => {
    try {
      if (id) {
        // Kill specific bot via ID
        if (window.electronAPI) {
            await window.electronAPI.closeMeeting(id);
        }
        return;
      }

      // Manual Leave (Current Session)
      handleStopAnalysis();

      if (window.electronAPI) {
        await window.electronAPI.closeMeeting();
      }

      if (analyticsServiceRef.current) {
        const sessionData = analyticsServiceRef.current.endSession();
        if (sessionData) {
          const filename = `meeting-${sessionData.id}-${new Date().toISOString().slice(0, 10)}`;
          analyticsServiceRef.current.downloadExport(filename, {
            format: 'json',
            includeTranscript: true,
            includeSentiment: true,
            includeWordTiming: false
          });
        }
      }

      setAppState((prev: AppState) => ({
        ...prev,
        isInMeeting: false,
        currentSession: null,
        status: 'Left meeting and exported data'
      }));

    } catch (error) {
      console.error('Error leaving meeting:', error);
      setAppState((prev: AppState) => ({
        ...prev,
        error: (error as Error).message
      }));
    }
  };

  const formatTimestamp = (timestamp: number): string => {
    return new Date(timestamp).toLocaleTimeString();
  };

  const convertInt16ToFloat32 = (buffer: ArrayBuffer): Float32Array => {
    const int16Array = new Int16Array(buffer);
    const float32Array = new Float32Array(int16Array.length);
    
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768; 
    }
    return float32Array;
  };

  // --- 7. RENDER ---
  return (
    <div className="min-h-screen bg-gray-100 font-sans text-gray-900">
      <div className="container mx-auto px-4 py-8 max-w-6xl">
        
        {/* HEADER */}
        <header className="flex justify-between items-center mb-8 bg-white p-6 rounded-2xl shadow-sm border border-gray-200">
          <div>
            <h1 className="text-3xl font-bold text-indigo-700">AI Fleet Commander</h1>
            <p className="text-gray-500 text-sm mt-1">Automated Meeting Assistant & Note Taker</p>
          </div>
          <div className="text-right">
            <div className="text-xs font-mono text-gray-400 mb-1">MONITORING TARGET</div>
            <div className="text-sm font-medium text-gray-700 bg-gray-100 px-3 py-1 rounded-full truncate max-w-xs">
              {serverUrl.replace('https://', '')}
            </div>
          </div>
        </header>

        {/* MONITOR DASHBOARD */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            
            {/* STATUS CARD */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 md:col-span-1">
                <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Scanner Status</h3>
                
                {activeBots.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-32 space-y-3">
                        <div className="relative flex h-4 w-4">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-4 w-4 bg-indigo-500"></span>
                        </div>
                        <p className="text-indigo-600 font-medium animate-pulse">Scanning for meetings...</p>
                        <p className="text-xs text-gray-400">Polling every 3s</p>
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center h-32 space-y-3">
                        <div className="h-4 w-4 rounded-full bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]"></div>
                        <p className="text-green-600 font-bold text-lg">{activeBots.length} Active Meeting{activeBots.length > 1 ? 's' : ''}</p>
                    </div>
                )}
            </div>

            {/* ACTIVE LIST */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 md:col-span-2 flex flex-col">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Active Deployments</h3>
                    <button onClick={syncStatus} className="text-xs text-indigo-600 hover:text-indigo-800 underline">
                        Sync (Last: {lastSync || "Not synced"})
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto max-h-40 space-y-3">
                    {activeBots.length === 0 ? (
                        <div className="flex items-center justify-center h-full border-2 border-dashed border-gray-100 rounded-lg">
                            <p className="text-gray-400 text-sm">No active meetings found on server.</p>
                        </div>
                    ) : (
                        activeBots.map((bot) => (
                            <div key={bot.id} className={`flex items-center justify-between p-3 border rounded-lg transition-colors ${appState.meetingUrl === bot.url ? 'bg-green-50 border-green-300' : 'bg-indigo-50 border-indigo-100'}`}>
                                <div className="flex items-center gap-3">
                                    <div className={`h-2 w-2 rounded-full ${appState.meetingUrl === bot.url ? 'bg-green-600 animate-pulse' : 'bg-green-500'}`}></div>
                                    <div>
                                        <p className="font-bold text-indigo-900 text-sm">{bot.id}</p>
                                        <p className="text-xs text-indigo-600 font-mono truncate w-48">{bot.url}</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-3">
                                    <button 
                                        onClick={() => handleMonitorBot(bot)}
                                        disabled={appState.isRecording && appState.meetingUrl === bot.url}
                                        className="px-3 py-1.5 bg-indigo-600 text-white text-xs font-bold rounded hover:bg-indigo-700 disabled:bg-gray-300 transition-all shadow-sm"
                                    >
                                        {appState.isRecording && appState.meetingUrl === bot.url ? 'MONITORING' : 'MONITOR / CONTROL'}
                                    </button>
                                    
                                    <button 
                                        onClick={() => handleLeaveMeeting(bot.id)}
                                        className="px-3 py-1.5 bg-white text-red-500 text-xs font-bold rounded border border-red-200 hover:bg-red-50 hover:border-red-300 transition-all shadow-sm"
                                    >
                                        TERMINATE
                                    </button>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>

        {/* MANUAL CONTROLS */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Manual Override</h3>
          <div className="flex flex-col md:flex-row gap-4">
             <input
                type="url"
                value={appState.meetingUrl}
                onChange={(e) => setAppState((prev: AppState) => ({ ...prev, meetingUrl: e.target.value }))}
                placeholder="Enter manual meeting URL..."
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 text-sm"
                disabled={appState.isInMeeting}
              />
              <div className="flex gap-2">
                {!appState.isInMeeting ? (
                    <button
                        onClick={handleJoinMeeting}
                        disabled={!appState.meetingUrl.trim()}
                        className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:bg-gray-300 text-sm font-medium transition-colors"
                    >
                        Join Manually
                    </button>
                ) : (
                    <>
                        <button onClick={handleStartAnalysis} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">Start Analysis</button>
                        <button onClick={() => handleLeaveMeeting()} className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700">Leave</button>
                    </>
                )}
                {/* Debug Button */}
                <button onClick={() => handleBotResponse("Hello bot")} className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-300">Test AI</button>
              </div>
          </div>
          <p className="text-xs text-gray-400 mt-2 ml-1">Status: {appState.status}</p>
        </div>

        {/* TRANSCRIPT & AI AREA */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
             <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 min-h-[300px]">
                <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Live Transcript Stream</h3>
                {transcript.length === 0 ? (
                    <div className="flex items-center justify-center h-48 text-gray-400 text-sm bg-gray-50 rounded-lg border border-gray-100 border-dashed">
                        Waiting for active audio stream...
                    </div>
                ) : (
                    <div className="space-y-4 max-h-96 overflow-y-auto pr-2">
                        {transcript.map((t, i) => (
                            <div key={i} className="flex gap-3">
                                <div className="w-8 h-8 rounded-full bg-gray-200 flex-shrink-0 flex items-center justify-center text-xs font-bold text-gray-500">
                                    {t.speakerIndex}
                                </div>
                                <div>
                                    <p className="text-sm text-gray-800 bg-gray-50 p-2 rounded-tr-lg rounded-br-lg rounded-bl-lg">
                                        {t.text}
                                    </p>
                                    <span className="text-[10px] text-gray-400 ml-1">{(t.confidence * 100).toFixed(0)}% • {new Date(sessionStartTime + t.startTime * 1000).toLocaleTimeString()}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
             </div>

             <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 min-h-[300px]">
                <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">AI Intelligence</h3>
                
                {botResponses.length === 0 ? (
                    <div className="flex items-center justify-center h-48 text-gray-400 text-sm bg-gray-50 rounded-lg border border-gray-100 border-dashed">
                        AI Context Window (Gemini 2.5) - Idle
                    </div>
                ) : (
                    <div className="space-y-3 max-h-96 overflow-y-auto pr-2">
                        {botResponses.map((response, index) => (
                            <div key={index} className="bg-indigo-50 border border-indigo-100 rounded-lg p-3">
                                <div className="flex items-center mb-1">
                                    <span className="text-xs font-bold text-indigo-700 uppercase tracking-wide">{response.speaker}</span>
                                    <span className="text-[10px] text-indigo-400 ml-2">{formatTimestamp(response.timestamp)}</span>
                                </div>
                                <p className="text-sm text-indigo-900 whitespace-pre-wrap leading-relaxed">{response.text}</p>
                            </div>
                        ))}
                    </div>
                )}
             </div>
        </div>

      </div>
    </div>
  );
}