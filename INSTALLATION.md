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
> Use Node.js 20 LTS for the Electron toolchain used by this project.

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

### 🎙️ Phase 4: Whisper.cpp STT

Compile the included streaming adapter against Whisper.cpp and download a model. The `turbo` model is the recommended default for Portuguese:

```bash
npm run whisper:build
npm run whisper:model
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
