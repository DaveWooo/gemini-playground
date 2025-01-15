import { Logger } from '../utils/logger.js';
import { ApplicationError, ErrorCodes } from '../utils/error-boundary.js';
import { CONFIG } from '../config/config.js';

/**
 * @class AudioRecorder
 * @description Handles audio recording functionality with configurable sample rate
 * and real-time audio processing through WebAudio API.
 */
export class AudioRecorder {
    /**
     * @constructor
     * @param {number} sampleRate - The sample rate for audio recording (default: 16000)
     */
    constructor(sampleRate = CONFIG.AUDIO.SAMPLE_RATE) {
        this.sampleRate = sampleRate;
        this.stream = null;
        this.mediaRecorder = null;
        this.audioContext = null;
        this.source = null;
        this.processor = null;
        this.onAudioData = null;
        
        // Bind methods to preserve context
        this.start = this.start.bind(this);
        this.stop = this.stop.bind(this);

        // Add state tracking
        this.isRecording = false;

        // 添加语音识别相关属性
        this.recognition = null;
        this.initSpeechRecognition();
    }

    initSpeechRecognition() {
        try {
            console.log('🎤 Initializing speech recognition...');
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            if (!SpeechRecognition) {
                Logger.warn('❌ Speech recognition not supported in this browser');
                return;
            }

            this.recognition = new SpeechRecognition();
            this.recognition.continuous = true;
            this.recognition.interimResults = true;
            this.recognition.lang = 'zh-CN'; // 设置为中文识别

            this.recognition.onresult = (event) => {
                const result = event.results[event.results.length - 1];
                const transcript = result[0].transcript;
                
                // 将识别结果输出到 logs-container
                const logsContainer = document.getElementById('logs-container');
                if (logsContainer) {
                    const logEntry = document.createElement('div');
                    logEntry.className = 'log-entry speech-recognition';
                    logEntry.innerHTML = `🎤 识别结果: ${transcript}`;
                    logsContainer.appendChild(logEntry);
                    logsContainer.scrollTop = logsContainer.scrollHeight;
                }
                
                Logger.info(`🎤 Speech recognized: ${transcript}`);
            };

            this.recognition.onerror = (event) => {
                Logger.error('❌ Speech recognition error:', event.error);
            };

        } catch (error) {
            Logger.error('❌ Error initializing speech recognition:', error);
        }
    }

    /**
     * @method start
     * @description Starts audio recording with the specified callback for audio data.
     * @param {Function} onAudioData - Callback function for processed audio data.
     * @throws {Error} If unable to access microphone or set up audio processing.
     * @async
     */
    async start(onAudioData) {
        Logger.info('🎤 Starting audio recording...');
        this.onAudioData = onAudioData;
        try {
            // Request microphone access
            Logger.info('🎤 Requesting microphone access...');
            this.stream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    channelCount: 1,
                    sampleRate: this.sampleRate
                } 
            });
            Logger.info('✅ Microphone access granted');
            
            this.audioContext = new AudioContext({ sampleRate: this.sampleRate });
            this.source = this.audioContext.createMediaStreamSource(this.stream);
            Logger.info(`🔊 Audio context created with sample rate: ${this.sampleRate}`);
            
            // Load worklet
            Logger.info('⚙️ Loading audio processing worklet...');
            await this.audioContext.audioWorklet.addModule('js/audio/worklets/audio-processing.js');
            Logger.info('✅ Audio worklet loaded');
            
            // 创建 processor
            this.processor = new AudioWorkletNode(this.audioContext, 'audio-recorder-worklet');
            
            // 确保 processor 创建成功后再设置消息处理
            if (this.processor && this.processor.port) {
                this.processor.port.onmessage = (event) => {
                    if (event.data.event === 'chunk' && this.onAudioData && this.isRecording) {
                        Logger.debug('📢 Audio chunk processed');
                        const base64Data = this.arrayBufferToBase64(event.data.data.int16arrayBuffer);
                        this.onAudioData(base64Data);
                    }
                };

                // Connect audio nodes
                this.source.connect(this.processor);
                this.processor.connect(this.audioContext.destination);
                this.isRecording = true;

                // 启动语音识别
                if (this.recognition) {
                    this.recognition.start();
                    Logger.info('🎤 Speech recognition started');
                }
            } else {
                throw new Error('Failed to create audio processor');
            }
        } catch (error) {
            Logger.error('❌ Error starting audio recording:', error);
            throw error;
        }
    }

    /**
     * @method stop
     * @description Stops the current recording session and cleans up resources.
     * @throws {ApplicationError} If an error occurs during stopping the recording.
     */
    stop() {
        try {
            if (!this.isRecording) {
                Logger.warn('Attempting to stop recording when not recording');
                return;
            }

            // Stop the microphone stream
            if (this.stream) {
                this.stream.getTracks().forEach(track => track.stop());
                this.stream = null;
            }

            // 停止语音识别
            if (this.recognition) {
                this.recognition.stop();
                Logger.info('🎤 Speech recognition stopped');
            }
            
            this.isRecording = false;
            Logger.info('Audio recording stopped successfully');
        } catch (error) {
            Logger.error('Error stopping audio recording', error);
            throw new ApplicationError(
                'Failed to stop audio recording',
                ErrorCodes.AUDIO_STOP_FAILED,
                { originalError: error }
            );
        }
    }

    /**
     * @method arrayBufferToBase64
     * @description Converts ArrayBuffer to Base64 string.
     * @param {ArrayBuffer} buffer - The ArrayBuffer to convert.
     * @returns {string} The Base64 representation of the ArrayBuffer.
     * @throws {ApplicationError} If an error occurs during conversion.
     * @private
     */
    arrayBufferToBase64(buffer) {
        try {
            const bytes = new Uint8Array(buffer);
            let binary = '';
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            return btoa(binary);
        } catch (error) {
            Logger.error('Error converting buffer to base64', error);
            throw new ApplicationError(
                'Failed to convert audio data',
                ErrorCodes.AUDIO_CONVERSION_FAILED,
                { originalError: error }
            );
        }
    }

    /**
     * @method checkBrowserSupport
     * @description Checks if the browser supports required audio APIs.
     * @throws {ApplicationError} If the browser does not support audio recording.
     * @private
     */
    checkBrowserSupport() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new ApplicationError(
                'Audio recording is not supported in this browser',
                ErrorCodes.AUDIO_NOT_SUPPORTED
            );
        }
    }
} 