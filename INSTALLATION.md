# ⚙️ AI Assistant Installation Guide

Follow these steps to set up **AI Assistant** on a fresh Linux/Ubuntu machine.

---

### 📦 Phase 1: System Dependencies

Install the required C++ graphical, audio tools, and system loopback utilities using your package manager:

```bash
sudo apt-get update && sudo apt-get install -y \
  libnss3 \
  libatk-bridge2.0-0 \
  libx11-xcb1 \
  libdrm2 \
  libgbm1 \
  libasound2 \
  libxshmfence1 \
  pulseaudio-utils \
  pipewire-utils \
  sox
```

---

### 🟢 Phase 2: Node.js Version Constraint

> [!IMPORTANT]
> You **MUST** use Node.js version **20 (LTS)**. The native dependency `ffi-napi` (which Vosk relies on to bridge native C libraries) will fail to build or load on newer versions like Node v22.

We recommend using **NVM** (Node Version Manager) to switch versions:

```bash
# Install Node 20 LTS
nvm install 20

# Switch your active terminal to Node 20
nvm use 20
```

---

### 🦙 Phase 3: Local AI Model (Ollama)

Install the local Ollama LLM provider and download the lightweight fallback model:

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull the lightweight fallback model
ollama run gemma2:2b
```

---

### 🎙️ Phase 4: Vosk STT Model

Download and extract the local English speech recognition model. Make sure it is placed in the project root directory:

```bash
# Download the model zip file
wget https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip

# Unzip the contents
unzip vosk-model-small-en-us-0.15.zip

# Rename the folder to the expected name
mv vosk-model-small-en-us-0.15 vosk-model

# Clean up the zip file
rm vosk-model-small-en-us-0.15.zip
```

---

### 🔑 Phase 5: Environment Variables

Expose your cloud provider keys if you plan to use them. Copy and export these in your session terminal:

```bash
export GEMINI_API_KEY="your_google_gemini_api_key"
export ANTHROPIC_API_KEY="your_anthropic_claude_api_key"
export OPENAI_API_KEY="your_openai_chatgpt_api_key"
```

> [!NOTE]
> If no API keys are provided or found in the environment, the copilot will automatically route all transcript payloads to the local **Ollama** instance.

---

### 🚀 Phase 6: Running the App

Install dependencies and start the hot-reloading development environment:

```bash
# Install node packages
npm install

# Start the dev build & launch the Electron application
npm run dev
```
