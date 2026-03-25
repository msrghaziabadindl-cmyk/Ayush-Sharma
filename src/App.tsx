import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { QRCodeSVG } from 'qrcode.react';
import { 
  Monitor, Smartphone, Play, Square, Shield, Zap, 
  MousePointer2, Wifi, WifiOff, Activity, Terminal,
  LayoutDashboard, Cast, ArrowLeft, RefreshCw
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Utility for Tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const getValidServerUrl = () => {
  if (typeof window === 'undefined') return '';
  const origin = window.location.origin;
  return origin !== 'null' ? origin : '';
};

const SERVER_URL = getValidServerUrl();
const SHARED_URL = "https://ais-pre-n6vsnlg7fhpt5mtbcpneku-26864643577.asia-east1.run.app";

type Tab = 'screen' | 'remote' | 'logs' | 'chat';

export default function App() {
  // Connection & Room State
  const [socket, setSocket] = useState<Socket | null>(null);
  
  // My Credentials (Host)
  const [myId, setMyId] = useState(() => {
    const id = Math.floor(100000000 + Math.random() * 900000000).toString();
    return `${id.slice(0,3)} ${id.slice(3,6)} ${id.slice(6,9)}`;
  });
  const [myPassword, setMyPassword] = useState(() => {
    return Math.floor(1000 + Math.random() * 9000).toString();
  });

  // Partner Credentials (Client)
  const [partnerId, setPartnerId] = useState('');
  const [partnerPassword, setPartnerPassword] = useState('');

  // Active Session State
  const [roomId, setRoomId] = useState('');
  const [role, setRole] = useState<'host' | 'client' | null>(null);
  const [peerConnectionState, setPeerConnectionState] = useState<RTCPeerConnectionState>('new');
  
  // Permission State
  const [joinStatus, setJoinStatus] = useState<'idle' | 'requesting' | 'denied' | 'wrong_password'>('idle');

  // Feature State
  const [isSharing, setIsSharing] = useState(false);
  const [isRemoteControlActive, setIsRemoteControlActive] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('screen');
  const [logs, setLogs] = useState<string[]>([]);
  const [chatMessages, setChatMessages] = useState<{sender: string, text: string, time: string}[]>([]);
  const [chatInput, setChatInput] = useState('');

  // Remote Control Input State (For Host to display)
  const [remoteInput, setRemoteInput] = useState({ x: 0, y: 0, key: '', clicked: false });

  // Refs
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);

  const addLog = (msg: string) => {
    setLogs(prev => [...prev, `${new Date().toLocaleTimeString()} - ${msg}`]);
  };

  // 1. Socket Initialization
  useEffect(() => {
    const newSocket = io(SERVER_URL, {
      path: '/api/socket.io',
      transports: ['websocket', 'polling']
    });
    setSocket(newSocket);

    newSocket.on('connect', () => {
      addLog('Connected to signaling server');
      // Always join own room to be ready for incoming connections
      newSocket.emit('join-room', myId.replace(/\s/g, ''));
    });
    
    newSocket.on('connect_error', (err) => {
      console.error('Socket connect error:', err);
      addLog(`Connection error: ${err.message}`);
    });
    
    newSocket.on('disconnect', (reason) => addLog(`Disconnected: ${reason}`));

    newSocket.on('user-joined', async (userId) => {
      addLog(`User ${userId} joined the room`);
      if (role === 'host') {
        await createOffer();
      }
    });

    newSocket.on('join-request', (data) => {
      addLog(`Received join request from ${data.clientId}`);
      if (data.password === myPassword) {
        // Auto-allow if password matches
        addLog(`Password matched. Auto-allowing ${data.clientId}`);
        setRole('host');
        setRoomId(myId.replace(/\s/g, ''));
        newSocket.emit('join-response', { clientId: data.clientId, roomId: myId.replace(/\s/g, ''), allowed: true });
      } else {
        // Deny if password wrong
        addLog(`Wrong password from ${data.clientId}. Denying.`);
        newSocket.emit('join-response', { clientId: data.clientId, roomId: myId.replace(/\s/g, ''), allowed: false, reason: 'wrong_password' });
      }
    });

    newSocket.on('join-response', (data) => {
      if (data.allowed) {
        addLog('Host allowed you to join');
        setJoinStatus('idle');
        setRoomId(data.roomId);
        setRole('client');
        newSocket.emit('join-room', data.roomId);
      } else {
        addLog(data.reason === 'wrong_password' ? 'Wrong password' : 'Host denied your join request');
        setJoinStatus(data.reason === 'wrong_password' ? 'wrong_password' : 'denied');
      }
    });

    newSocket.on('offer', async (data) => {
      addLog('Received offer from host');
      await handleOffer(data.offer);
    });

    newSocket.on('answer', async (data) => {
      addLog('Received answer from client');
      await handleAnswer(data.answer);
    });

    newSocket.on('ice-candidate', async (data) => {
      await handleIceCandidate(data.candidate);
    });

    return () => {
      newSocket.disconnect();
    };
  }, [role, myId, myPassword]);

  // 2. WebRTC Setup & Data Channel (Any Network Config)
  const setupDataChannel = (dc: RTCDataChannel) => {
    dataChannelRef.current = dc;
    dc.onopen = () => addLog('Data channel opened');
    dc.onclose = () => addLog('Data channel closed');
    dc.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'REMOTE_CONTROL_TOGGLE') {
          setIsRemoteControlActive(data.active);
          addLog(`Remote control ${data.active ? 'enabled' : 'disabled'} by peer`);
        } else if (data.type === 'MOUSE_MOVE') {
          setRemoteInput(prev => ({ ...prev, x: data.x, y: data.y }));
        } else if (data.type === 'MOUSE_CLICK') {
          setRemoteInput(prev => ({ ...prev, x: data.x, y: data.y, clicked: true }));
          // Reset click visual after 200ms
          setTimeout(() => setRemoteInput(prev => ({ ...prev, clicked: false })), 200);
        } else if (data.type === 'KEY_DOWN') {
          setRemoteInput(prev => ({ ...prev, key: data.key }));
          // Clear key visual after 1s
          setTimeout(() => setRemoteInput(prev => ({ ...prev, key: '' })), 1000);
        } else if (data.type === 'CHAT_MESSAGE') {
          setChatMessages(prev => [...prev, { sender: 'Partner', text: data.text, time: data.time }]);
          addLog(`Received message from partner`);
        }
      } catch (e) {
        console.error('Failed to parse data channel message', e);
      }
    };
  };

  const setupPeerConnection = () => {
    // Configured for ANY network (STUN + Free TURN server fallback for symmetric NATs)
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        }
      ]
    });

    pc.onicecandidate = (event) => {
      if (event.candidate && socket && roomId) {
        socket.emit('ice-candidate', { roomId, candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      addLog('Received remote video track');
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    pc.onconnectionstatechange = () => {
      setPeerConnectionState(pc.connectionState);
      addLog(`Connection state changed: ${pc.connectionState}`);
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        setIsRemoteControlActive(false);
        setIsSharing(false);
      }
    };

    // If client, listen for data channel. If host, we create it in createOffer.
    pc.ondatachannel = (event) => {
      setupDataChannel(event.channel);
    };

    peerConnectionRef.current = pc;
    return pc;
  };

  const sendChatMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || dataChannelRef.current?.readyState !== 'open') return;
    
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const message = { type: 'CHAT_MESSAGE', text: chatInput, time };
    
    dataChannelRef.current.send(JSON.stringify(message));
    setChatMessages(prev => [...prev, { sender: 'Me', text: chatInput, time }]);
    setChatInput('');
  };

  // 3. Room Management
  const createRoom = () => {
    const newRoomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    setRoomId(newRoomId);
    setRole('host');
    socket?.emit('join-room', newRoomId);
    addLog(`Created room: ${newRoomId}`);
  };

  const joinRoom = () => {
    if (!partnerId || !partnerPassword) return;
    const cleanRoomId = partnerId.replace(/\s/g, '');
    setJoinStatus('requesting');
    setRole('client'); // Set role early so socket listener knows we are client
    socket?.emit('request-join', { roomId: cleanRoomId, password: partnerPassword });
    addLog(`Requested to join room: ${cleanRoomId}`);
  };

  const handleJoinResponse = (clientId: string, allowed: boolean) => {
    socket?.emit('join-response', { clientId, roomId, allowed });
    setPendingRequests(prev => prev.filter(req => req.clientId !== clientId));
    addLog(`${allowed ? 'Allowed' : 'Denied'} join request from ${clientId}`);
  };

  const leaveRoom = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    stopScreenShare();
    setRoomId('');
    setRole(null);
    setJoinStatus('idle');
    setPendingRequests([]);
    setPeerConnectionState('new');
    setIsRemoteControlActive(false);
    addLog('Left room');
  };

  const refreshApp = () => {
    window.location.reload();
  };

  // 4. Screen Sharing
  const startScreenShare = async () => {
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
          audio: true
        });
      } catch (err: any) {
        console.warn('Failed with audio, trying video only...', err);
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } }
        });
      }

      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      setIsSharing(true);
      addLog('Started screen sharing');

      if (peerConnectionRef.current) {
        stream.getTracks().forEach(track => {
          peerConnectionRef.current?.addTrack(track, stream);
        });
        await createOffer();
      }

      stream.getVideoTracks()[0].onended = () => stopScreenShare();
    } catch (err: any) {
      console.error('Screen share error:', err);
      if (err.name === 'NotAllowedError' || err.message?.includes('Permission denied')) {
        addLog('Permission denied: Please allow screen sharing access.');
        alert('Screen sharing permission was denied. Please allow access when prompted.');
      } else {
        addLog(`Failed to start screen share: ${err.message || err}`);
      }
    }
  };

  const stopScreenShare = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    setIsSharing(false);
    addLog('Stopped screen sharing');
  };

  // 5. Remote Control Actions & Event Listeners
  const toggleRemoteControl = () => {
    const newState = !isRemoteControlActive;
    setIsRemoteControlActive(newState);
    if (dataChannelRef.current?.readyState === 'open') {
      dataChannelRef.current.send(JSON.stringify({ type: 'REMOTE_CONTROL_TOGGLE', active: newState }));
      addLog(`Toggled remote control: ${newState ? 'ON' : 'OFF'}`);
    } else {
      addLog('Cannot toggle remote control: Data channel not open');
      setIsRemoteControlActive(!newState);
    }
  };

  // Client-side: Capture Mouse Movements
  const handleRemoteMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isRemoteControlActive || role !== 'client' || dataChannelRef.current?.readyState !== 'open') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    dataChannelRef.current.send(JSON.stringify({ type: 'MOUSE_MOVE', x, y }));
  };

  // Client-side: Capture Mouse Clicks
  const handleRemoteMouseClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isRemoteControlActive || role !== 'client' || dataChannelRef.current?.readyState !== 'open') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    dataChannelRef.current.send(JSON.stringify({ type: 'MOUSE_CLICK', x, y, button: e.button }));
  };

  // Client-side: Capture Keyboard Events
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isRemoteControlActive || role !== 'client' || dataChannelRef.current?.readyState !== 'open') return;
      
      // Prevent default browser scrolling/shortcuts if we are actively controlling
      if (e.key.length === 1 || ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Backspace', 'Tab', 'Escape'].includes(e.key)) {
        e.preventDefault();
      }
      
      dataChannelRef.current.send(JSON.stringify({ type: 'KEY_DOWN', key: e.key }));
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isRemoteControlActive, role]);

  // 6. WebRTC Signaling
  const createOffer = async () => {
    const pc = peerConnectionRef.current || setupPeerConnection();
    
    // Host creates the data channel
    if (!dataChannelRef.current) {
      const dc = pc.createDataChannel('control', { ordered: false, maxRetransmits: 0 });
      setupDataChannel(dc);
    }

    if (localStreamRef.current) {
      const senders = pc.getSenders();
      localStreamRef.current.getTracks().forEach(track => {
        if (!senders.find(s => s.track === track)) {
          pc.addTrack(track, localStreamRef.current!);
        }
      });
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket?.emit('offer', { roomId, offer });
  };

  const handleOffer = async (offer: RTCSessionDescriptionInit) => {
    const pc = peerConnectionRef.current || setupPeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket?.emit('answer', { roomId, answer });
  };

  const handleAnswer = async (answer: RTCSessionDescriptionInit) => {
    const pc = peerConnectionRef.current;
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
  };

  const handleIceCandidate = async (candidate: RTCIceCandidateInit) => {
    const pc = peerConnectionRef.current;
    if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate));
  };

  // UI Helpers
  const getConnectionStatusConfig = () => {
    switch (peerConnectionState) {
      case 'connected': return { color: 'bg-green-500', text: 'Connected', icon: Wifi };
      case 'connecting': return { color: 'bg-yellow-500', text: 'Connecting...', icon: Activity };
      case 'disconnected': 
      case 'failed': 
      case 'closed': return { color: 'bg-red-500', text: 'Disconnected', icon: WifiOff };
      default: return { color: 'bg-neutral-500', text: 'Waiting for peer', icon: Wifi };
    }
  };

  const statusConfig = getConnectionStatusConfig();
  const StatusIcon = statusConfig.icon;

  // Render: Disconnected View
  if (!roomId) {
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-100 font-sans flex flex-col items-center justify-center p-4">
        <div className="max-w-4xl w-full space-y-8">
          <div className="text-center space-y-2">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-blue-500/10 mb-4">
              <Monitor className="w-8 h-8 text-blue-500" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight">AnyMirror</h1>
            <p className="text-neutral-400">Cross-platform screen mirroring & control</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Host Section */}
            <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 space-y-6 shadow-xl">
              <div className="space-y-2">
                <h2 className="text-xl font-medium flex items-center gap-2">
                  <Shield className="w-6 h-6 text-blue-400" />
                  Allow Remote Control
                </h2>
                <p className="text-sm text-neutral-400">Please tell your partner the following ID and Password to connect to your desktop.</p>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-neutral-400 mb-1">Your ID</label>
                  <div className="bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-3 font-mono text-2xl tracking-widest text-white text-center">
                    {myId || '...'}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-neutral-400 mb-1">Password</label>
                  <div className="bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-3 font-mono text-2xl tracking-widest text-white text-center">
                    {myPassword || '...'}
                  </div>
                </div>
              </div>
            </div>

            {/* Join Section */}
            <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 space-y-6 shadow-xl">
              <div className="space-y-2">
                <h2 className="text-xl font-medium flex items-center gap-2">
                  <Cast className="w-6 h-6 text-green-400" />
                  Control Remote Computer
                </h2>
                <p className="text-sm text-neutral-400">Please enter your partner's ID and Password to control their computer.</p>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-neutral-400 mb-1">Partner ID</label>
                  <input 
                    type="text" 
                    value={partnerId}
                    onChange={(e) => {
                      setPartnerId(e.target.value);
                      if (joinStatus !== 'idle' && joinStatus !== 'requesting') setJoinStatus('idle');
                    }}
                    disabled={joinStatus === 'requesting'}
                    placeholder="e.g. 123 456 789" 
                    className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-3 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 font-mono text-xl tracking-widest placeholder:tracking-normal disabled:opacity-50 text-center"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-neutral-400 mb-1">Password</label>
                  <input 
                    type="text" 
                    value={partnerPassword}
                    onChange={(e) => {
                      setPartnerPassword(e.target.value);
                      if (joinStatus !== 'idle' && joinStatus !== 'requesting') setJoinStatus('idle');
                    }}
                    disabled={joinStatus === 'requesting'}
                    placeholder="e.g. 1234" 
                    className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-3 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 font-mono text-xl tracking-widest placeholder:tracking-normal disabled:opacity-50 text-center"
                  />
                </div>

                <button 
                  onClick={joinRoom}
                  disabled={!partnerId || !partnerPassword || joinStatus === 'requesting'}
                  className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-3 rounded-xl transition-colors flex items-center justify-center gap-2 mt-4"
                >
                  {joinStatus === 'requesting' ? (
                    <><Activity className="w-5 h-5 animate-spin" /> Connecting...</>
                  ) : (
                    'Connect to partner'
                  )}
                </button>

                {joinStatus === 'denied' && (
                  <p className="text-sm text-red-400 text-center mt-2">Connection denied.</p>
                )}
                {joinStatus === 'wrong_password' && (
                  <p className="text-sm text-red-400 text-center mt-2">Wrong password. Please try again.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Render: Connected View
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 font-sans flex flex-col">
      {/* Top Navigation Bar */}
      <header className="border-b border-neutral-800 bg-neutral-900/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-screen-2xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button 
              onClick={leaveRoom} 
              className="p-2 hover:bg-neutral-800 rounded-lg text-neutral-400 hover:text-white transition-colors"
              title="Back to Home"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <button 
              onClick={refreshApp} 
              className="p-2 hover:bg-neutral-800 rounded-lg text-neutral-400 hover:text-white transition-colors"
              title="Refresh App"
            >
              <RefreshCw className="w-5 h-5" />
            </button>
            <div className="h-6 w-px bg-neutral-800 hidden sm:block mx-2"></div>
            <div className="flex items-center gap-2">
              <Monitor className="w-5 h-5 text-blue-500" />
              <span className="font-semibold tracking-tight hidden sm:inline-block">AnyMirror</span>
            </div>
            <div className="flex items-center gap-3 ml-4">
              <span className="text-sm text-neutral-400">Room:</span>
              <span className="font-mono font-bold text-lg tracking-widest text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded">{roomId}</span>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className={cn("flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border", 
              peerConnectionState === 'connected' ? "bg-green-500/10 text-green-400 border-green-500/20" : 
              peerConnectionState === 'connecting' ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/20" : 
              "bg-neutral-800 text-neutral-400 border-neutral-700"
            )}>
              <StatusIcon className="w-3.5 h-3.5" />
              {statusConfig.text}
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-screen-2xl w-full mx-auto p-4 flex flex-col lg:flex-row gap-6 relative">
        
        {/* Left Sidebar: Controls & Tabs */}
        <div className="w-full lg:w-80 flex flex-col gap-4 shrink-0">
          {/* Tab Navigation */}
          <div className="flex flex-wrap p-1 bg-neutral-900 rounded-xl border border-neutral-800">
            <button 
              onClick={() => setActiveTab('screen')}
              className={cn("flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-lg transition-all", 
                activeTab === 'screen' ? "bg-neutral-800 text-white shadow-sm" : "text-neutral-400 hover:text-neutral-200")}
            >
              <Cast className="w-4 h-4" /> Screen
            </button>
            <button 
              onClick={() => setActiveTab('remote')}
              className={cn("flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-lg transition-all", 
                activeTab === 'remote' ? "bg-neutral-800 text-white shadow-sm" : "text-neutral-400 hover:text-neutral-200")}
            >
              <MousePointer2 className="w-4 h-4" /> Control
            </button>
            <button 
              onClick={() => setActiveTab('chat')}
              className={cn("flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-lg transition-all", 
                activeTab === 'chat' ? "bg-neutral-800 text-white shadow-sm" : "text-neutral-400 hover:text-neutral-200")}
            >
              Chat
            </button>
            <button 
              onClick={() => setActiveTab('logs')}
              className={cn("flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-lg transition-all", 
                activeTab === 'logs' ? "bg-neutral-800 text-white shadow-sm" : "text-neutral-400 hover:text-neutral-200")}
            >
              <Terminal className="w-4 h-4" /> Logs
            </button>
          </div>

          {/* Tab Content Area */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 flex-1 flex flex-col">
            
            {/* SCREEN TAB */}
            {activeTab === 'screen' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-sm font-medium text-neutral-200 mb-1">Screen Sharing</h3>
                  <p className="text-xs text-neutral-500 mb-4">Share your entire screen, a specific window, or a browser tab.</p>
                  
                  {!isSharing ? (
                    <button 
                      onClick={startScreenShare}
                      className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2"
                    >
                      <Play className="w-4 h-4" /> Start Sharing
                    </button>
                  ) : (
                    <button 
                      onClick={stopScreenShare}
                      className="w-full bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20 font-medium py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2"
                    >
                      <Square className="w-4 h-4" /> Stop Sharing
                    </button>
                  )}
                </div>

                {role === 'host' && !isSharing && peerConnectionState !== 'connected' && (
                  <div className="pt-4 border-t border-neutral-800">
                    <h3 className="text-sm font-medium text-neutral-200 mb-3">Invite via QR</h3>
                    <div className="bg-white p-3 rounded-xl inline-block">
                      <QRCodeSVG value={`${SHARED_URL}?room=${roomId}`} size={120} />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* REMOTE CONTROL TAB */}
            {activeTab === 'remote' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-sm font-medium text-neutral-200 mb-1">Remote Control</h3>
                  <p className="text-xs text-neutral-500 mb-4">Allow the connected peer to control your mouse and keyboard, or request control of theirs.</p>
                  
                  <div className="p-4 bg-neutral-950 border border-neutral-800 rounded-lg mb-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-neutral-400">Data Channel</span>
                      <span className={cn("w-2 h-2 rounded-full", dataChannelRef.current?.readyState === 'open' ? "bg-green-500" : "bg-neutral-600")}></span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-neutral-400">Control Status</span>
                      <span className={cn("text-xs font-medium px-2 py-1 rounded", isRemoteControlActive ? "bg-blue-500/20 text-blue-400" : "bg-neutral-800 text-neutral-500")}>
                        {isRemoteControlActive ? 'ACTIVE' : 'INACTIVE'}
                      </span>
                    </div>
                  </div>

                  <button 
                    onClick={toggleRemoteControl}
                    disabled={dataChannelRef.current?.readyState !== 'open'}
                    className={cn(
                      "w-full font-medium py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2 border",
                      isRemoteControlActive 
                        ? "bg-red-500/10 text-red-500 border-red-500/20 hover:bg-red-500/20" 
                        : "bg-blue-600 text-white border-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    )}
                  >
                    <MousePointer2 className="w-4 h-4" />
                    {isRemoteControlActive ? 'Revoke Control' : 'Enable Control'}
                  </button>
                  
                  {dataChannelRef.current?.readyState !== 'open' && (
                    <p className="text-xs text-amber-500/80 mt-2 text-center">
                      Must be connected to a peer to enable control.
                    </p>
                  )}
                </div>

                {/* Host View: Live Remote Inputs Visualizer */}
                {role === 'host' && isRemoteControlActive && (
                  <div className="pt-4 border-t border-neutral-800">
                    <h4 className="text-sm font-medium text-neutral-400 mb-3">Live Remote Inputs (Host View)</h4>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-neutral-950 p-3 rounded-lg border border-neutral-800">
                        <span className="text-[10px] uppercase tracking-wider text-neutral-500 block mb-1">Mouse</span>
                        <span className="font-mono text-xs text-blue-400">
                          X: {(remoteInput.x * 100).toFixed(1)}%<br/>
                          Y: {(remoteInput.y * 100).toFixed(1)}%
                        </span>
                      </div>
                      <div className="bg-neutral-950 p-3 rounded-lg border border-neutral-800">
                        <span className="text-[10px] uppercase tracking-wider text-neutral-500 block mb-1">Action</span>
                        <span className="font-mono text-xs text-green-400 break-all">
                          {remoteInput.clicked ? 'CLICK!' : remoteInput.key ? `KEY: ${remoteInput.key}` : 'Waiting...'}
                        </span>
                      </div>
                    </div>
                    <p className="text-[10px] text-neutral-500 mt-3 leading-relaxed">
                      * In a production desktop app, these coordinates would be passed to the OS via a native library (like robotjs) to move the actual cursor.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* CHAT TAB */}
            {activeTab === 'chat' && (
              <div className="flex flex-col h-full">
                <h3 className="text-sm font-medium text-neutral-200 mb-3">Chat</h3>
                <div className="flex-1 bg-neutral-950 border border-neutral-800 rounded-lg p-3 overflow-y-auto space-y-3 min-h-[200px] mb-3">
                  {chatMessages.map((msg, i) => (
                    <div key={i} className={cn("flex flex-col max-w-[85%]", msg.sender === 'Me' ? "ml-auto items-end" : "items-start")}>
                      <span className="text-[10px] text-neutral-500 mb-1">{msg.sender} • {msg.time}</span>
                      <div className={cn("px-3 py-2 rounded-xl text-sm", msg.sender === 'Me' ? "bg-blue-600 text-white rounded-tr-sm" : "bg-neutral-800 text-neutral-200 rounded-tl-sm")}>
                        {msg.text}
                      </div>
                    </div>
                  ))}
                  {chatMessages.length === 0 && <div className="text-neutral-600 text-sm text-center mt-10">No messages yet. Say hi!</div>}
                </div>
                <form onSubmit={sendChatMessage} className="flex gap-2">
                  <input 
                    type="text" 
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Type a message..."
                    className="flex-1 bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                    disabled={dataChannelRef.current?.readyState !== 'open'}
                  />
                  <button 
                    type="submit"
                    disabled={!chatInput.trim() || dataChannelRef.current?.readyState !== 'open'}
                    className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  >
                    Send
                  </button>
                </form>
              </div>
            )}

            {/* LOGS TAB */}
            {activeTab === 'logs' && (
              <div className="flex flex-col h-full">
                <h3 className="text-sm font-medium text-neutral-200 mb-3">System Logs</h3>
                <div className="flex-1 bg-neutral-950 border border-neutral-800 rounded-lg p-3 overflow-y-auto font-mono text-xs text-neutral-400 space-y-1.5 min-h-[200px]">
                  {logs.map((log, i) => (
                    <div key={i} className="break-words">{log}</div>
                  ))}
                  {logs.length === 0 && <div className="text-neutral-600 italic">No logs yet...</div>}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Area: Video Feeds */}
        <div className="flex-1 flex flex-col gap-4 min-h-[500px]">
          {/* Main Remote Video Container */}
          <div 
            className={cn(
              "flex-1 bg-black border rounded-2xl overflow-hidden relative flex items-center justify-center transition-all duration-300",
              isRemoteControlActive ? "border-blue-500 shadow-[0_0_30px_rgba(59,130,246,0.2)] cursor-crosshair" : "border-neutral-800"
            )}
            onMouseMove={handleRemoteMouseMove}
            onMouseDown={handleRemoteMouseClick}
          >
            
            <video 
              ref={remoteVideoRef} 
              autoPlay 
              playsInline 
              className="w-full h-full object-contain pointer-events-none"
            />
            
            {/* Empty State */}
            {!remoteVideoRef.current?.srcObject && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-neutral-600 bg-neutral-900/50 pointer-events-none">
                <Monitor className="w-16 h-16 mb-4 opacity-30" />
                <p className="text-lg font-medium text-neutral-400">Waiting for remote screen...</p>
                <p className="text-sm mt-2">When the other peer shares their screen, it will appear here.</p>
              </div>
            )}

            {/* Remote Control Active Overlay */}
            {isRemoteControlActive && (
              <div className="absolute top-4 right-4 bg-blue-600 text-white px-3 py-1.5 rounded-full text-xs font-medium flex items-center gap-2 shadow-lg animate-pulse pointer-events-none">
                <MousePointer2 className="w-3.5 h-3.5" />
                Remote Control Active
              </div>
            )}

            {/* Label */}
            <div className="absolute bottom-4 left-4 bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-2 text-white border border-white/10 pointer-events-none">
              <span className={cn("w-2 h-2 rounded-full", remoteVideoRef.current?.srcObject ? "bg-green-500" : "bg-neutral-500")}></span>
              Remote Feed
            </div>
          </div>

          {/* Picture-in-Picture Local Video (Only show if sharing) */}
          {isSharing && (
            <div className="absolute bottom-8 right-8 w-64 aspect-video bg-black border border-neutral-700 rounded-xl overflow-hidden shadow-2xl z-10 relative">
              <video 
                ref={localVideoRef} 
                autoPlay 
                playsInline 
                muted
                className="w-full h-full object-cover pointer-events-none"
              />
              <div className="absolute bottom-2 left-2 bg-black/60 backdrop-blur-md px-2 py-1 rounded text-[10px] font-medium flex items-center gap-1.5 text-white pointer-events-none">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
                You (Sharing)
              </div>

              {/* Virtual Cursor Overlay (Host sees client's mouse) */}
              {role === 'host' && isRemoteControlActive && (
                <div 
                  className="absolute pointer-events-none z-20 transition-all duration-75"
                  style={{ 
                    left: `${remoteInput.x * 100}%`, 
                    top: `${remoteInput.y * 100}%`,
                    transform: 'translate(-50%, -50%)' 
                  }}
                >
                  <MousePointer2 className={cn("w-5 h-5 drop-shadow-md", remoteInput.clicked ? "text-red-500 scale-90" : "text-blue-500")} fill="currentColor" />
                  {remoteInput.clicked && (
                    <span className="absolute inset-0 rounded-full bg-red-500/50 animate-ping"></span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
