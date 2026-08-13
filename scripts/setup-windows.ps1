$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js LTS が必要です。winget install OpenJS.NodeJS.LTS を実行してください。"
}

npm install
npm test
npm run dev
