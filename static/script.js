document.addEventListener('DOMContentLoaded', () => {
    const connectBtn = document.getElementById('connectBtn');
    const destroyBtn = document.getElementById('destroyBtn');
    const recordBtn = document.getElementById('recordBtn');
    const stopRecordBtn = document.getElementById('stopRecordBtn');
    const textInput = document.getElementById('textInput');
    const submitTextBtn = document.getElementById('submitTextBtn');
    const statusP = document.getElementById('status');
    const didVideo = document.getElementById('didVideo');
    const connectionStatusDiv = document.getElementById('connectionStatus');
    const logsPre = document.getElementById('logs');
    const chatHistoryDiv = document.getElementById('chatHistory');

    let mediaRecorder;
    let audioChunks = [];
    let peerConnection;

    // Globals to store active D-ID session details
    let currentStreamId = null;
    let currentSessionIdFromBody = null; // D-ID's session_id (cookie-like string)
    let agentTextToSpeak = null; // Text for the avatar to speak in the current turn

    let sdpSuccessfullySubmitted = false;
    let isSessionActiveAndConnected = false; // Tracks if WebRTC is fully up
    let chatMessages = [];

    function logMessage(message, isError = false) {
        const prefix = isError ? "ERROR: " : "LOG: ";
        console.log(prefix, message);
        const messageText = (typeof message === 'object' ? JSON.stringify(message, null, 2) : message);
        logsPre.textContent += prefix + messageText + '\n';
        logsPre.scrollTop = logsPre.scrollHeight;
    }

    function updateChatHistoryUI(sender, text) {
        chatMessages.push({ sender, text });
        const messageEl = document.createElement('div');
        messageEl.classList.add('chat-message');
        if (sender === 'User') {
            messageEl.classList.add('user-message');
            messageEl.textContent = `You: ${text}`;
        } else {
            messageEl.classList.add('agent-message');
            messageEl.textContent = `Agent: ${text}`;
        }
        chatHistoryDiv.appendChild(messageEl);
        chatHistoryDiv.scrollTop = chatHistoryDiv.scrollHeight;
    }

    function clearChatHistoryUI() {
        chatMessages = [];
        chatHistoryDiv.innerHTML = '';
    }

    function updateButtonStates() {
        connectBtn.disabled = isSessionActiveAndConnected;
        destroyBtn.disabled = !isSessionActiveAndConnected;
        textInput.disabled = !isSessionActiveAndConnected;
        submitTextBtn.disabled = !isSessionActiveAndConnected;
        recordBtn.disabled = !isSessionActiveAndConnected;
        // stopRecordBtn is managed by recording state
    }
    updateButtonStates(); // Initial state

    // --- Session Management ---
    connectBtn.onclick = async () => {
        if (isSessionActiveAndConnected) return;
        logMessage("Connect button clicked. Initiating session...");
        statusP.textContent = "Connecting to D-ID service...";
        updateButtonStates(); // Disable connect, etc.
        clearChatHistoryUI();

        const formData = new FormData();
        formData.append('text_input', 'SYSTEM_CONNECT_REQUEST'); // Marker for initial connection

        try {
            // Step 1: Call Flask to initiate D-ID stream and get offer
            const response = await fetch('/initiate_did_stream', { // NEW FLASK ENDPOINT
                method: 'POST',
                body: formData
            });
            const data = await response.json();

            if (!response.ok || data.error) {
                throw new Error(data.error || `Server error (${response.status})`);
            }

            logMessage(`Received stream details from server: ${JSON.stringify(data).substring(0,200)}`);
            currentStreamId = data.stream_id_for_path;
            currentSessionIdFromBody = data.session_id_for_body; // Store D-ID's session_id
            const offerSdp = data.offer_sdp;
            const iceServers = data.ice_servers;
            const agentInitialGreeting = data.agent_initial_greeting;

            if (!currentStreamId || !currentSessionIdFromBody || !offerSdp || !iceServers) {
                throw new Error("Incomplete stream data received (IDs, offer, or ICE missing).");
            }

            updateChatHistoryUI("Agent", agentInitialGreeting); // Show greeting

            // Step 2: Initialize WebRTC with the offer
            statusP.textContent = "Initializing WebRTC connection...";
            await initializeAndConnectWebRTC(offerSdp, iceServers);
            // isSessionActiveAndConnected will be set true inside initializeAndConnectWebRTC on success

        } catch (error) {
            logMessage(`Error during connection setup: ${error.message}`, true);
            statusP.textContent = `Connection Error: ${error.message}`;
            resetFullSession(); // Reset everything if connection fails
        }
    };

    destroyBtn.onclick = async () => {
        if (!currentStreamId) { // Check if a session was even active
            logMessage("Destroy: No active stream to destroy.", true);
            resetFullSession(); // Ensure client state is reset
            return;
        }
        logMessage("Destroy Session button clicked.");
        statusP.textContent = "Disconnecting session...";

        try {
            const response = await fetch('/destroy_did_session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    stream_id_for_path: currentStreamId,
                    session_id_for_body: currentSessionIdFromBody // Send D-ID specific session_id
                })
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || `Failed to destroy session (status ${response.status})`);
            }
            logMessage("D-ID session destroyed successfully on server.");
        } catch (error) {
            logMessage(`Error destroying D-ID session on server: ${error.message}`, true);
        } finally {
            resetFullSession(); // Always reset client-side state
        }
    };


    // --- Audio Recording ---
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        recordBtn.onclick = async () => {
            if (!isSessionActiveAndConnected) return;
            try {
                // ... (rest of the recording logic is the same)
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

                mediaRecorder.ondataavailable = (event) => audioChunks.push(event.data);

                mediaRecorder.onstop = async () => {
                    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                    audioChunks = [];
                    recordBtn.disabled = !isSessionActiveAndConnected;
                    stopRecordBtn.disabled = true;
                    statusP.textContent = "Processing audio...";
                    await processSubsequentInput(audioBlob); // Use new function
                };
                mediaRecorder.start();
                statusP.textContent = "Recording...";
                recordBtn.disabled = true;
                stopRecordBtn.disabled = false;
            } catch (err) {
                logMessage(`Error accessing microphone: ${err.message}`, true);
                statusP.textContent = `Error: ${err.message}`;
                recordBtn.disabled = !isSessionActiveAndConnected;
                stopRecordBtn.disabled = true;
            }
        };
        stopRecordBtn.onclick = () => {
            if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
        };
    } else {
        statusP.textContent = "getUserMedia not supported on your browser!";
        if(recordBtn) recordBtn.disabled = true;
    }

    // --- Text Input ---
    submitTextBtn.onclick = () => {
        if (!isSessionActiveAndConnected) return;
        const text = textInput.value.trim();
        if (text) {
            statusP.textContent = "Processing text...";
            // User text added to chat inside processSubsequentInput after server confirms processing
            processSubsequentInput(text); // Use new function
            textInput.value = "";
        } else {
            statusP.textContent = "Please enter some text.";
        }
    };

    // NEW: Function for handling subsequent user inputs after initial connection
    async function processSubsequentInput(inputData) {
        if (!isSessionActiveAndConnected) {
            logMessage("Cannot process input: Session not active or connected.", true);
            statusP.textContent = "Error: Not connected.";
            return;
        }
        logMessage("Processing subsequent input...");
        statusP.textContent = "Getting agent response...";

        const formData = new FormData();
        if (inputData instanceof Blob) {
            formData.append('audio_data', inputData, 'recorded_audio.webm');
        } else if (typeof inputData === 'string') {
            formData.append('text_input', inputData);
        } else {
            logMessage("Invalid input type to processSubsequentInput.", true);
            return;
        }

        try {
            // Step 1: Get Gemini response (no D-ID stream creation here)
            const response = await fetch('/get_agent_response', { // NEW FLASK ENDPOINT
                method: 'POST',
                body: formData
            });
            const data = await response.json();

            if (!response.ok || data.error) {
                throw new Error(data.error || `Server error (${response.status}) getting agent response`);
            }
            logMessage(`Agent response received: ${data.agent_response_text}`);

            // Add user's processed input to chat (transcription or original text)
            if (data.user_text_processed) {
                updateChatHistoryUI("User", data.user_text_processed);
            }


            agentTextToSpeak = data.agent_response_text;
            updateChatHistoryUI("Agent", agentTextToSpeak);

            // Step 2: If WebRTC is ready, make the avatar speak
            if (isSessionActiveAndConnected && peerConnection &&
                (peerConnection.iceConnectionState === 'connected' || peerConnection.iceConnectionState === 'completed')) {
                await startTalk();
            } else {
                logMessage("WebRTC not ready to talk, though agent response was received.", true);
                statusP.textContent = "Connection issue. Try reconnecting.";
            }

        } catch (error) {
            logMessage(`Error in processSubsequentInput: ${error.message}`, true);
            statusP.textContent = `Error: ${error.message}`;
            // Don't reset full session here, user might want to try sending another message
            // Or, if the error is severe, a full reset might be needed.
        }
    }


    async function initializeAndConnectWebRTC(offerSdp, iceServers) {
        logMessage("Initializing WebRTC connection with received offer.");
        if (peerConnection) { // Clean up any existing (should not happen if flow is correct)
            logMessage("Warning: Existing peerConnection found during initial setup. Resetting.", true);
            closeCurrentPeerConnection();
        }
        sdpSuccessfullySubmitted = false;
        isSessionActiveAndConnected = false; // Not yet fully connected

        peerConnection = new RTCPeerConnection({ iceServers });

        peerConnection.ontrack = (event) => {
            logMessage("WebRTC track received.");
            if (event.streams && event.streams[0]) {
                didVideo.srcObject = event.streams[0];
            } else {
                let inboundStream = new MediaStream([event.track]);
                didVideo.srcObject = inboundStream;
            }
            didVideo.play().catch(e => {
                if (e.name === 'AbortError') {
                    logMessage('Video play() aborted, likely by a new source being set quickly. This is often recoverable.');
                } else {
                    logMessage(`Video play error: ${e.name} - ${e.message}`, true);
                }
            });
        };

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                logMessage(`ICE candidate: ${event.candidate.candidate.substring(0, 70)}...`);
            } else {
                logMessage("ICE gathering finished.");
            }
        };

        const handleConnectionChange = () => {
            logMessage(`ICE connection state: ${peerConnection.iceConnectionState}, Peer connection state: ${peerConnection.connectionState}`);
            connectionStatusDiv.textContent = `ICE: ${peerConnection.iceConnectionState}, Peer: ${peerConnection.connectionState}`;

            if ((peerConnection.iceConnectionState === 'connected' || peerConnection.iceConnectionState === 'completed') &&
                 peerConnection.connectionState === 'connected') {
                if (sdpSuccessfullySubmitted) {
                    logMessage("WebRTC fully connected and SDP submitted.");
                    statusP.textContent = "Connected to Avatar. Ready for your input.";
                    isSessionActiveAndConnected = true;
                } else {
                    logMessage("WebRTC transport connected, but SDP not yet confirmed as submitted.");
                }
            } else if (['failed', 'disconnected', 'closed'].includes(peerConnection.iceConnectionState) ||
                       ['failed', 'disconnected', 'closed'].includes(peerConnection.connectionState)) {
                logMessage("WebRTC connection lost or failed.", true);
                statusP.textContent = `Connection ${peerConnection.iceConnectionState}/${peerConnection.connectionState}. Please reconnect.`;
                resetFullSession(); // Full reset on connection failure
            }
            updateButtonStates();
        };

        peerConnection.oniceconnectionstatechange = handleConnectionChange;
        peerConnection.onconnectionstatechange = handleConnectionChange;


        try {
            logMessage("Setting remote description (D-ID's offer).");
            await peerConnection.setRemoteDescription(new RTCSessionDescription(offerSdp));

            logMessage("Creating SDP answer.");
            const sdpAnswer = await peerConnection.createAnswer();
            logMessage("Setting local description (our answer).");
            await peerConnection.setLocalDescription(sdpAnswer);

            logMessage("Preparing to send SDP answer to server.");
            if (!currentStreamId || !currentSessionIdFromBody) { // Use the stored IDs for this session
                throw new Error("Client-side error: Stream IDs not available for sending SDP answer.");
            }

            const payloadToFlaskForSdp = {
                stream_id_for_path: currentStreamId,
                session_id_for_body: currentSessionIdFromBody, // D-ID specific session_id
                sdp_answer: sdpAnswer
            };
            logMessage(`Sending SDP payload (first 100 chars): ${JSON.stringify(payloadToFlaskForSdp).substring(0,100)}...`);

            const sdpResponse = await fetch('/submit_sdp_answer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payloadToFlaskForSdp)
            });
            const sdpResult = await sdpResponse.json();

            if (!sdpResponse.ok || sdpResult.error) {
                throw new Error(sdpResult.error || `SDP submission failed via backend (${sdpResponse.status})`);
            }

            sdpSuccessfullySubmitted = true;
            logMessage("SDP Answer successfully submitted to D-ID via Flask. D-ID's response:");
            logMessage(sdpResult);
            statusP.textContent = "SDP Answer sent. Waiting for connection to complete...";
            // Connection state change handlers will set isSessionActiveAndConnected

        } catch (error) {
            logMessage(`Error in WebRTC setup or SDP exchange: ${error.message}`, true);
            statusP.textContent = `WebRTC Error: ${error.message}`;
            sdpSuccessfullySubmitted = false;
            resetFullSession(); // Reset on critical WebRTC setup error
        }
    }

    async function startTalk() {
        if (!isSessionActiveAndConnected) {
            logMessage("Cannot start talk: Session is not active/connected.", true); return;
        }
        if (!sdpSuccessfullySubmitted) { // Should be ensured by isSessionActiveAndConnected
            logMessage("Cannot start talk: SDP not successfully submitted.", true); return;
        }
        if (!peerConnection || !['connected', 'completed'].includes(peerConnection.iceConnectionState)) {
            logMessage(`Cannot start talk: PeerConnection not ready. ICE State: ${peerConnection ? peerConnection.iceConnectionState : 'N/A'}`, true);
            return;
        }
        if (!agentTextToSpeak) {
            logMessage("Cannot start talk: No agent response text available.", true); return;
        }
        if (!currentStreamId || !currentSessionIdFromBody) {
            logMessage("Cannot start talk: Missing stream/session IDs.", true); return;
        }

        logMessage(`Starting talk stream with text: ${agentTextToSpeak.substring(0,50)}...`);
        const payloadToFlaskForTalk = {
            stream_id_for_path: currentStreamId,
            session_id_for_body: currentSessionIdFromBody, // D-ID specific session_id
            text_to_speak: agentTextToSpeak
        };
        logMessage(`Payload to Flask (/start_talk_stream): ${JSON.stringify(payloadToFlaskForTalk).substring(0,100)}...`);

        statusP.textContent = "Starting avatar speech...";
        try {
            const talkResponse = await fetch('/start_talk_stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payloadToFlaskForTalk)
            });
            const talkResult = await talkResponse.json();
            if (!talkResponse.ok || talkResult.error) {
                throw new Error(talkResult.error || `Start talk failed via backend (${talkResponse.status})`);
            }
            logMessage("Start talk request successful. D-ID's response:");
            logMessage(talkResult);
            statusP.textContent = "Avatar speaking...";
        } catch (error) {
            logMessage(`Error starting talk: ${error.message}`, true);
            statusP.textContent = `Error starting talk: ${error.message}`;
        }
    }
    
    function closeCurrentPeerConnection() {
        if (peerConnection) {
            logMessage("Closing existing peer connection.");
            peerConnection.onicecandidate = null;
            peerConnection.oniceconnectionstatechange = null;
            peerConnection.onconnectionstatechange = null;
            peerConnection.ontrack = null;
            peerConnection.close();
            peerConnection = null;
        }
         if (didVideo.srcObject) {
            didVideo.srcObject.getTracks().forEach(track => track.stop());
            didVideo.srcObject = null;
        }
        didVideo.pause();
    }

    function resetFullSession() {
        logMessage("Resetting full session state.");
        closeCurrentPeerConnection();

        currentStreamId = null;
        currentSessionIdFromBody = null; // Clear D-ID specific session_id
        agentTextToSpeak = null;
        sdpSuccessfullySubmitted = false;
        isSessionActiveAndConnected = false;

        connectionStatusDiv.textContent = "Connection Status: Idle/Closed";
        statusP.textContent = "Ready. Please connect to avatar.";
        // Chat history is intentionally NOT cleared here, cleared on new connect
        updateButtonStates();
    }
});