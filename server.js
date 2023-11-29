const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Deepgram } = require("@deepgram/sdk");
const dotenv = require("dotenv");
const { OpenAI } = require('openai');
const https = require('https');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const client = new Deepgram(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
let keepAlive;
let startTime;
let deepgramSTTStartTime; // Variable to store the start time for Deepgram transcription
let firstPacketSent = false; // Flag to check if the first packet has been sent

// Function to manage the size of audio packets
function createAudioPacketManager(deepgram) {
  const BUFFER_DURATION_MS = 50; // Set the desired buffer duration in milliseconds (e.g., 50 ms)
  let buffer = Buffer.alloc(0);
  let lastSendTime = Date.now();

  function sendBuffer() {
    if (buffer.length > 0) {
      deepgram.send(buffer);
      buffer = Buffer.alloc(0);
    }
    lastSendTime = Date.now();
  }

  return {
    addToBuffer: function (data) {
      buffer = Buffer.concat([buffer, data]);

      if (Date.now() - lastSendTime >= BUFFER_DURATION_MS) {
        sendBuffer();
      }
    },
    flush: function () {
      sendBuffer();
    },
  };
}

const setupDeepgram = (socket) => {
  const deepgram = client.transcription.live({
    language: "en",
    punctuate: true,
    smart_format: false,
    filler_words: false,
    interim_results: false, // whether to send only is_final=true
    model: "nova-2",
    // uncomment below for Apple Watch
    encoding: "linear16", // Specify encoding here
    sample_rate: 44100,    // Specify sample rate here
    channels: 1            // Specify number of channels here
  });

  if (keepAlive) clearInterval(keepAlive);
  keepAlive = setInterval(() => {
    console.log("deepgram: keepalive");
    deepgram.keepAlive();
  }, 10 * 1000);

  deepgram.addListener("open", async () => {
    console.log("deepgram: connected");

    deepgram.addListener("close", async () => {
      console.log("deepgram: disconnected");
      clearInterval(keepAlive);
      deepgram.finish();
    });

    deepgram.addListener("error", async (error) => {
      console.log("deepgram: error received");
      console.error(error);
    });

    deepgram.addListener("transcriptReceived", async (packet) => {
      if (firstPacketSent) {
        const deepgramSTTTime = Date.now() - deepgramSTTStartTime;
        console.log(`Deepgram_stt_time: Time from first packet to transcription: ${deepgramSTTTime} ms`);
        firstPacketSent = false; // Reset the flag after logging the time
      }
      console.log("deepgram: packet received");
      const data = JSON.parse(packet);
      const { type } = data;
      switch (type) {
        case "Results":
          console.log("deepgram: transcript received");
          const transcript = data.channel.alternatives[0].transcript ?? "";
          console.log("socket: transcript sent to client");
          socket.emit("transcript", transcript);

          // Call generateSpeech directly with the transcript and socket
          await generateSpeech(transcript, socket);
          break;
        case "Metadata":
          console.log("deepgram: metadata received");
          break;
        default:
          console.log("deepgram: unknown packet received");
          break;
      }
    });

  });

  return deepgram;
};

async function generateSpeech(text, socket) {
  if (!text || text.trim().length === 0) {
    console.log("generateSpeech: Received empty text, not sending to OpenAI TTS");
    return;
  }

  console.log(`generateSpeech: Sending text to OpenAI TTS: "${text}"`);
  startTime = new Date(); // Record start time just before sending the request

  try {
    const response = await openai.audio.speech.create({
      model: "tts-1",
      voice: "onyx",
      input: text,
    });

    // Handling the response as a stream
    let chunks = [];
    response.body.on('data', (chunk) => {
      chunks.push(chunk);
    });

    response.body.on('end', () => {
      const endTime = new Date(); // Record end time when response is fully received
      const delay = endTime - startTime; // Calculate the delay
      console.log(`Delay from request to TTS response: ${delay} ms`);

      const audioData = Buffer.concat(chunks);
      console.log("generateSpeech: Audio data received, sending to client");
      socket.emit("audio-chunk", audioData);
    });

  } catch (error) {
    console.error('generateSpeech: Error generating speech:', error);
  }
}


io.on("connection", (socket) => {
  console.log("socket: client connected");
  let deepgram = setupDeepgram(socket);
  let audioPacketManager = createAudioPacketManager(deepgram);

  socket.on("packet-sent", (data) => {
    // console.log("socket: client data received");
    if (!firstPacketSent) {
      deepgramSTTStartTime = Date.now(); // Record start time for the first packet
      firstPacketSent = true;
    }
    audioPacketManager.addToBuffer(data);

    if (deepgram.getReadyState() >= 2) {
      console.log("socket: data couldn't be sent to deepgram");
      console.log("socket: retrying connection to deepgram");
      deepgram.finish();
      deepgram.removeAllListeners();
      deepgram = setupDeepgram(socket);
      audioPacketManager = createAudioPacketManager(deepgram);
    }
  });

  socket.on("disconnect", () => {
    console.log("socket: client disconnected");
    deepgram.finish();
    deepgram.removeAllListeners();
    deepgram = null;
  });
});

app.use(express.static("public/"));
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

server.listen(3000, () => {
  console.log("listening on localhost:3000");
});
