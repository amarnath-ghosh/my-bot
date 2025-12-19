// app/page.tsx
"use client";

import { useEffect, useState, useRef } from "react";

type BotState = "idle" | "joining" | "connected" | "error" | "ended";

interface MeetingStatus {
  meetingID: string;
  meetingName: string;
  participantCount?: number;
  isRunning?: boolean;
  botState: BotState;
  lastError?: string;
}

interface TranscriptEntry {
  meetingID: string;
  speaker: string;
  text: string;
  timestamp: string;
}

interface BotApi {
  getSnapshot(): Promise<MeetingStatus[]>;
  onMeetingsUpdate(callback: (meetings: MeetingStatus[]) => void): () => void;
  onTranscript(callback: (data: TranscriptEntry) => void): () => void;
  join(id: string): Promise<void>;
  leave(id: string): Promise<void>;
  restart(id: string): Promise<void>;
  setAutoManage(enabled: boolean): Promise<void>;
  simulateHello(id: string): Promise<void>;
}

export default function Home() {
  const [meetings, setMeetings] = useState<MeetingStatus[]>([]);
  const [autoManage, setAutoManage] = useState(true);
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);

  const transcriptEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const api = (window as any).botApi as BotApi;
    if (api) {
      api.getSnapshot().then(setMeetings);

      const cleanupMeetings = api.onMeetingsUpdate((data) => {
        setMeetings(data);
        // Auto-select first active meeting if none selected
        if (!selectedMeetingId && data.length > 0) {
          // Optional: setSelectedMeetingId(data[0].meetingID);
        }
      });

      const cleanupTranscript = api.onTranscript((data) => {
        setTranscripts((prev) => [...prev, data]);
      });

      return () => {
        cleanupMeetings();
        cleanupTranscript();
      };
    }
  }, [selectedMeetingId]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcripts]);

  const toggleAuto = async () => {
    const next = !autoManage;
    setAutoManage(next);
    await (window as any).botApi.setAutoManage(next);
  };

  const activeMeeting = meetings.find(m => m.meetingID === selectedMeetingId);
  const filteredTranscripts = selectedMeetingId
    ? transcripts.filter(t => t.meetingID === selectedMeetingId)
    : transcripts;

  return (
    <main style={{
      height: '100vh',
      display: 'flex',
      fontFamily: "'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
      background: '#1a1a1a',
      color: '#e0e0e0'
    }}>

      {/* Sidebar: Meetings */}
      <div style={{
        width: '320px',
        background: '#252525',
        borderRight: '1px solid #333',
        display: 'flex',
        flexDirection: 'column'
      }}>
        <div style={{ padding: '20px', borderBottom: '1px solid #333' }}>
          <h1 style={{ margin: 0, fontSize: '1.2rem', color: '#fff', fontWeight: 600 }}>🤖 Meeting Bot</h1>
          <div style={{ marginTop: '15px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{
              width: '40px', height: '20px', background: autoManage ? '#4caf50' : '#555',
              borderRadius: '10px', position: 'relative', cursor: 'pointer', transition: 'background 0.3s'
            }} onClick={toggleAuto}>
              <div style={{
                width: '16px', height: '16px', background: '#fff', borderRadius: '50%',
                position: 'absolute', top: '2px', left: autoManage ? '22px' : '2px', transition: 'left 0.3s'
              }} />
            </div>
            <span style={{ fontSize: '0.85rem', color: '#aaa' }}>Auto-Join {autoManage ? 'ON' : 'OFF'}</span>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {meetings.map(m => (
            <div
              key={m.meetingID}
              onClick={() => setSelectedMeetingId(m.meetingID)}
              style={{
                padding: '15px',
                borderBottom: '1px solid #333',
                cursor: 'pointer',
                background: selectedMeetingId === m.meetingID ? '#2d3342' : 'transparent',
                borderLeft: selectedMeetingId === m.meetingID ? '3px solid #64b5f6' : '3px solid transparent',
                transition: 'background 0.2s'
              }}
            >
              <div style={{ fontWeight: 600, color: '#fff', marginBottom: '4px' }}>{m.meetingName}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: '#aaa' }}>
                <span>👥 {m.participantCount ?? 0}</span>
                <span style={{
                  color: m.botState === 'connected' ? '#66bb6a' :
                    m.botState === 'joining' ? '#ffa726' :
                      m.botState === 'error' ? '#ef5350' : '#999'
                }}>
                  ● {m.botState.toUpperCase()}
                </span>
              </div>
              {m.lastError && (
                <div style={{ fontSize: '0.75rem', color: '#ff6b6b', marginTop: '4px' }}>⚠️ {m.lastError}</div>
              )}
            </div>
          ))}
          {meetings.length === 0 && (
            <div style={{ padding: '20px', color: '#666', textAlign: 'center', fontStyle: 'italic' }}>
              Searching for meetings...
            </div>
          )}
        </div>

        {/* Debug Footer */}
        <div style={{ padding: '10px', borderTop: '1px solid #333', fontSize: '0.7rem', color: '#666' }}>
          Debug: {meetings.length} meetings loaded.
        </div>
      </div>

      {/* Main Area: details & Transcript */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>

        {activeMeeting ? (
          <>
            {/* Header */}
            <div style={{
              padding: '20px',
              borderBottom: '1px solid #333',
              background: '#222',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <div>
                <h2 style={{ margin: 0, fontSize: '1.2rem' }}>{activeMeeting.meetingName}</h2>
                <div style={{ fontSize: '0.85rem', color: '#888', marginTop: '4px' }}>ID: {activeMeeting.meetingID}</div>
              </div>

              <div style={{ display: 'flex', gap: '10px' }}>
                {activeMeeting.botState === 'connected' && (
                  <button
                    onClick={() => (window as any).botApi.simulateHello(activeMeeting.meetingID)}
                    style={{
                      padding: '8px 16px', background: '#7e57c2', color: 'white', border: 'none',
                      borderRadius: '6px', cursor: 'pointer', fontWeight: 600,
                      boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
                    }}>
                    👋 Simulate Hello
                  </button>
                )}

                {activeMeeting.botState === 'idle' && (
                  <button
                    onClick={() => (window as any).botApi.join(activeMeeting.meetingID)}
                    style={{
                      padding: '8px 16px', background: '#2196f3', color: 'white', border: 'none',
                      borderRadius: '6px', cursor: 'pointer', fontWeight: 600
                    }}>
                    Join Meeting
                  </button>
                )}

                {(activeMeeting.botState === 'connected' || activeMeeting.botState === 'joining') && (
                  <button
                    onClick={() => (window as any).botApi.leave(activeMeeting.meetingID)}
                    style={{
                      padding: '8px 16px', background: '#ef5350', color: 'white', border: 'none',
                      borderRadius: '6px', cursor: 'pointer', fontWeight: 600
                    }}>
                    Disconnect
                  </button>
                )}
              </div>
            </div>

            {/* Chat Area */}
            <div style={{ flex: 1, padding: '20px', overflowY: 'auto', background: '#1c1c1c' }}>
              {filteredTranscripts.length === 0 ? (
                <div style={{ textAlign: 'center', marginTop: '50px', color: '#444' }}>
                  <div style={{ fontSize: '3rem', marginBottom: '10px' }}>💬</div>
                  <div>Waiting for conversation...</div>
                </div>
              ) : (
                filteredTranscripts.map((t, i) => {
                  const isBot = t.speaker === 'Final' && (t.text.toLowerCase().includes('bot') || t.text.toLowerCase().includes('assistant'));
                  // This is a rough heuristic since we don't have speaker IDs for simulation

                  return (
                    <div key={i} style={{ marginBottom: '15px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                      <div style={{
                        marginBottom: '4px', fontSize: '0.75rem', color: '#666',
                        marginLeft: '6px'
                      }}>
                        {t.speaker} • {new Date(t.timestamp).toLocaleTimeString()}
                      </div>
                      <div style={{
                        padding: '10px 14px',
                        borderRadius: '12px',
                        background: '#333',
                        color: '#eee',
                        maxWidth: '80%',
                        lineHeight: '1.4'
                      }}>
                        {t.text}
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={transcriptEndRef} />
            </div>
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555' }}>
            Select a meeting from the sidebar to view details
          </div>
        )}
      </div>
    </main>
  );
}
