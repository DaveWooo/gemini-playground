import { registeredWorklets } from '../core/worklet-registry.js';
import { CONFIG } from '../config/config.js';
import { Logger } from '../utils/logger.js';

/**
 * @class AudioStreamer
 * @description Manages the playback of audio data, including support for queuing, scheduling, and applying audio effects through worklets.
 */
export class AudioStreamer {
    /**
     * @constructor
     * @param {AudioContext} context - The AudioContext instance to use for audio processing.
     */
    constructor(context) {
        this.context = context;
        this.audioQueue = [];
        this.isPlaying = false;
        this.sampleRate = CONFIG.AUDIO.OUTPUT_SAMPLE_RATE;
        this.bufferSize = 7680;
        this.processingBuffer = new Float32Array(0);
        this.scheduledTime = 0;
        this.gainNode = this.context.createGain();
        this.source = this.context.createBufferSource();
        this.isStreamComplete = false;
        this.checkInterval = null;
        this.initialBufferTime = 0.1;
        this.endOfQueueAudioSource = null;
        this.onComplete = () => { };
        this.gainNode.connect(this.context.destination);
        this.addPCM16 = this.addPCM16.bind(this);
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.speechRecognizer = null;
        this.isRecognitionActive = false;
        this.processor = null;
        this.initSpeechRecognition();
    }

    initSpeechRecognition() {
        try {
            console.log('🎤 Initializing server audio recognition...');
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            if (!SpeechRecognition) {
                Logger.warn('❌ Server audio recognition not supported');
                return;
            }

            this.speechRecognizer = new SpeechRecognition();
            this.speechRecognizer.continuous = true;
            this.speechRecognizer.interimResults = false;
            this.speechRecognizer.lang = 'zh-CN';
            
            // 处理识别结果
            this.speechRecognizer.onresult = (event) => {
                console.log('🔄 onresult:',event);
                const result = event.results[event.results.length - 1];
                if (result.isFinal) {
                    const transcript = result[0].transcript;
                    this.handleTranscript(transcript);
                }
            };

            // 改进错误处理
            this.speechRecognizer.onerror = (event) => {
                if (event.error === 'no-speech') {
                    console.log('🔄 No speech detected');
                    this.restartRecognition();
                } else {
                    Logger.error('❌ Server audio recognition error:', event.error);
                }
                this.isRecognitionActive = false;
            };

            // 改进结束处理
            this.speechRecognizer.onend = () => {
                console.log('🎤 Recognition session ended');
                this.isRecognitionActive = false;
                // 如果还在播放且不是主动停止，则重新启动识别
                if (this.isPlaying && !this.isStreamComplete) {
                    this.restartRecognition();
                }
            };

        } catch (error) {
            Logger.error('❌ Error initializing server audio recognition:', error);
        }
    }

    restartRecognition() {
        if (this.isRecognitionActive) {
            return;
        }
        
        try {
            console.log('🔄 Restarting recognition...');
            setTimeout(() => {
                if (!this.isRecognitionActive) {
                    this.speechRecognizer.start();
                    this.isRecognitionActive = true;
                    console.log('✅ Recognition restarted');
                }
            }, 100);
        } catch (error) {
            Logger.error('❌ Error restarting recognition:', error);
            this.isRecognitionActive = false;
        }
    }

    handleTranscript(transcript) {
        console.log('🤖 Server response transcript:', transcript);
        logMessage('Dave, How are you', 'Local');
        // 输出到日志容器
        const logsContainer = document.getElementById('logs-container');
        if (logsContainer) {
            const logEntry = document.createElement('div');
            logEntry.className = 'log-entry server-speech';
            logEntry.innerHTML = `🤖 服务器回复: ${transcript}`;
            logsContainer.appendChild(logEntry);
            logsContainer.scrollTop = logsContainer.scrollHeight;
        }
    }

    /**
     * @method addWorklet
     * @description Adds an audio worklet to the processing pipeline.
     * @param {string} workletName - The name of the worklet.
     * @param {string} workletSrc - The source URL of the worklet script.
     * @param {Function} handler - The message handler function for the worklet.
     * @returns {Promise<AudioStreamer>} A promise that resolves with the AudioStreamer instance when the worklet is added.
     * @async
     */
    async addWorklet(workletName, workletSrc, handler) {
        let workletsRecord = registeredWorklets.get(this.context);
        if (workletsRecord && workletsRecord[workletName]) {
            workletsRecord[workletName].handlers.push(handler);
            return Promise.resolve(this);
        }

        if (!workletsRecord) {
            registeredWorklets.set(this.context, {});
            workletsRecord = registeredWorklets.get(this.context);
        }

        workletsRecord[workletName] = { handlers: [handler] };

        try {
            const absolutePath = `/${workletSrc}`;
            await this.context.audioWorklet.addModule(absolutePath);
            
            // 创建 AudioWorkletNode
            this.processor = new AudioWorkletNode(this.context, workletName);
            workletsRecord[workletName].node = this.processor;

            // 设置消息处理
            if (this.processor && this.processor.port) {
                this.processor.port.onmessage = (ev) => {
                    if (handler) {
                        handler.call(this.processor.port, ev);
                    }
                };
            }

            return this;
        } catch (error) {
            console.error('Error loading worklet:', error);
            throw error;
        }
    }

    /**
     * @method addPCM16
     * @description Adds a chunk of PCM16 audio data to the streaming queue.
     * @param {Int16Array} chunk - The audio data chunk.
     */
    addPCM16(chunk) {
        console.log('📥 Received PCM16 audio chunk');
        
        // 确保在有音频数据时启动识别
        if (this.speechRecognizer && !this.isRecognitionActive) {
            try {
                console.log('🎤 Starting recognition for new audio stream');
                this.speechRecognizer.start();
                this.isRecognitionActive = true;
                Logger.info('🎤 Server audio recognition started');
            } catch (error) {
                Logger.error('❌ Error starting recognition:', error);
                this.isRecognitionActive = false;
            }
        }

        const float32Array = new Float32Array(chunk.length / 2);
        const dataView = new DataView(chunk.buffer);

        for (let i = 0; i < chunk.length / 2; i++) {
            try {
                const int16 = dataView.getInt16(i * 2, true);
                float32Array[i] = int16 / 32768;
            } catch (e) {
                console.error(e);
            }
        }

        const newBuffer = new Float32Array(this.processingBuffer.length + float32Array.length);
        newBuffer.set(this.processingBuffer);
        newBuffer.set(float32Array, this.processingBuffer.length);
        this.processingBuffer = newBuffer;

        while (this.processingBuffer.length >= this.bufferSize) {
            const buffer = this.processingBuffer.slice(0, this.bufferSize);
            this.audioQueue.push(buffer);
            this.processingBuffer = this.processingBuffer.slice(this.bufferSize);
        }

        if (!this.isPlaying) {
            Logger.info('▶️ Starting audio playback');
            this.isPlaying = true;
            this.scheduledTime = this.context.currentTime + this.initialBufferTime;
            this.scheduleNextBuffer();
        }
    }

    /**
     * @method createAudioBuffer
     * @description Creates an AudioBuffer from the given audio data.
     * @param {Float32Array} audioData - The audio data.
     * @returns {AudioBuffer} The created AudioBuffer.
     */
    createAudioBuffer(audioData) {
        const audioBuffer = this.context.createBuffer(1, audioData.length, this.sampleRate);
        audioBuffer.getChannelData(0).set(audioData);
        return audioBuffer;
    }

    /**
     * @method scheduleNextBuffer
     * @description Schedules the next audio buffer for playback.
     */
    scheduleNextBuffer() {
        if (this.audioQueue.length > 0) {
            //Logger.debug(`📊 Queue status: ${this.audioQueue.length} buffers remaining`);
        }
        else {
           //Logger.debug(' Queue is empty');
        }
        
        const SCHEDULE_AHEAD_TIME = 0.2;

        while (this.audioQueue.length > 0 && this.scheduledTime < this.context.currentTime + SCHEDULE_AHEAD_TIME) {
            const audioData = this.audioQueue.shift();
            const audioBuffer = this.createAudioBuffer(audioData);
            const source = this.context.createBufferSource();

            if (this.audioQueue.length === 0) {
                if (this.endOfQueueAudioSource) {
                    this.endOfQueueAudioSource.onended = null;
                }
                this.endOfQueueAudioSource = source;
                source.onended = () => {
                    if (!this.audioQueue.length && this.endOfQueueAudioSource === source) {
                        this.endOfQueueAudioSource = null;
                        this.onComplete();
                    }
                };
            }

            source.buffer = audioBuffer;
            source.connect(this.gainNode);
            Logger.debug('🔊 Audio source connected to gain node');

            // 如果 processor 存在，连接到处理器
            if (this.processor) {
                source.connect(this.processor);
                this.processor.connect(this.context.destination);
            }

            const startTime = Math.max(this.scheduledTime, this.context.currentTime);
            source.start(startTime);
            Logger.debug(`🎵 Started playing audio buffer at time: ${startTime}`);

            this.scheduledTime = startTime + audioBuffer.duration;
        }

        if (this.audioQueue.length === 0 && this.processingBuffer.length === 0) {
            if (this.isStreamComplete) {
                Logger.info('✅ Audio stream playback completed');
                this.isPlaying = false;
            }
        } else {
            const nextCheckTime = (this.scheduledTime - this.context.currentTime) * 1000;
            setTimeout(() => this.scheduleNextBuffer(), Math.max(0, nextCheckTime - 50));
        }
    }

    /**
     * @method stop
     * @description Stops the audio stream.
     */
    stop() {
        this.isPlaying = false;
        this.isStreamComplete = true;
        this.audioQueue = [];
        this.processingBuffer = new Float32Array(0);
        this.scheduledTime = this.context.currentTime;

        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }

        this.gainNode.gain.linearRampToValueAtTime(0, this.context.currentTime + 0.1);

        setTimeout(() => {
            this.gainNode.disconnect();
            this.gainNode = this.context.createGain();
            this.gainNode.connect(this.context.destination);
        }, 200);

        // 停止语音识别
        if (this.speechRecognizer && this.isRecognitionActive) {
            try {
                this.speechRecognizer.stop();
                this.isRecognitionActive = false;
                Logger.info('🎤 Server audio recognition stopped');
            } catch (error) {
                Logger.error('❌ Error stopping recognition:', error);
            }
        }
    }

    /**
     * @method resume
     * @description Resumes the audio stream if the AudioContext was suspended.
     * @async
     */
    async resume() {
        if (this.context.state === 'suspended') {
            await this.context.resume();
        }
        this.isStreamComplete = false;
        this.scheduledTime = this.context.currentTime + this.initialBufferTime;
        this.gainNode.gain.setValueAtTime(1, this.context.currentTime);
    }

    /**
     * @method complete
     * @description Marks the audio stream as complete and schedules any remaining data in the buffer.
     */
    complete() {
        Logger.info('🏁 Marking audio stream as complete');
        this.isStreamComplete = true;
        if (this.processingBuffer.length > 0) {
            Logger.debug('📝 Processing remaining buffer data');
            this.audioQueue.push(this.processingBuffer);
            this.processingBuffer = new Float32Array(0);
            if (this.isPlaying) {
                this.scheduleNextBuffer();
            }
        } else {
            this.onComplete();
        }
    }

    startRecognition(audioBlob) {
        if (!this.recognition) return;

        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        
        audio.addEventListener('ended', () => {
            URL.revokeObjectURL(audioUrl);
        });

        try {
            this.recognition.start();
            audio.play();
        } catch (error) {
            Logger.error('❌ Error starting recognition:', error);
        }
    }
} 