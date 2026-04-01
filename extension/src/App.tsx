import { useEffect, useState, useRef } from "react";
import { io, Socket } from "socket.io-client";

type BotState = "idle" | "joining" | "connected" | "error" | "ended";

interface MeetingStatus {
  meetingID: string;
  meetingName: string;
  participantCount?: number;
  isRunning?: boolean;
  botState: BotState;
  lastError?: string;
}

export default function App() {
  const [meetings, setMeetings] = useState<MeetingStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    // Connect to the local bot server
    const socket = io("http://localhost:3001");
    socketRef.current = socket;

    socket.on("connect", () => {
      setLoading(false);
      socket.emit("bot:getSnapshot", (data: MeetingStatus[]) => {
        if (Array.isArray(data)) setMeetings(data);
      });
    });

    socket.on("disconnect", () => {
      setLoading(true);
    });

    socket.on("meetings:update", (data: MeetingStatus[]) => {
      setMeetings(data);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <p>Connecting to Bot Engine...</p>
      </div>
    );
  }

  return (
    <div style={{ padding: '15px' }}>
      <h2 style={{ margin: '0 0 15px 0', borderBottom: '1px solid #333', paddingBottom: '10px' }}>🤖 Remote Controller</h2>
      
      {meetings.length === 0 ? (
        <p style={{ color: '#888', fontStyle: 'italic', textAlign: 'center', marginTop: '30px' }}>
          No active meetings found. Start one in your calendar!
        </p>
      ) : (
        meetings.map(m => (
          <div key={m.meetingID} style={{ 
            background: '#2d2d2d', 
            borderRadius: '8px', 
            padding: '12px', 
            marginBottom: '10px',
            border: `1px solid ${m.botState === 'connected' ? '#4caf50' : m.botState === 'joining' ? '#ff9800' : '#444'}`
          }}>
            <h3 style={{ margin: '0 0 5px 0', fontSize: '14px' }}>{m.meetingName || 'Untitled Meeting'}</h3>
            <div style={{ fontSize: '12px', color: '#aaa', marginBottom: '10px', display: 'flex', justifyContent: 'space-between' }}>
              <span>ID: {m.meetingID}</span>
              <span>● {m.botState.toUpperCase()}</span>
            </div>
            
            <div style={{ display: 'flex', gap: '8px' }}>
              {m.botState === 'idle' && (
                <button 
                  onClick={() => socketRef.current?.emit("bot:join", m.meetingID)}
                  style={{ flex: 1, padding: '6px', background: '#2196f3', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                >Join Meeting</button>
              )}
              
              {(m.botState === 'connected' || m.botState === 'joining') && (
                <button 
                  onClick={() => socketRef.current?.emit("bot:leave", m.meetingID)}
                  style={{ flex: 1, padding: '6px', background: '#e53935', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                >Disconnect</button>
              )}
            </div>
            {m.lastError && <div style={{ color: '#ff5252', fontSize: '11px', marginTop: '8px' }}>⚠️ {m.lastError}</div>}
          </div>
        ))
      )}
    </div>
  );
}
