#!/bin/zsh

set -e
cd -- "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

port="${PORT:-4317}"
address="http://localhost:$port"
if health=$(curl --silent --fail --max-time 1 "http://127.0.0.1:$port/api/health") && [[ "$health" == *'"app":"safe4wiki"'* || "$health" == *'"app":"repowiki"'* ]]; then
  exec open "$address"
fi

if ! command -v node >/dev/null; then
  print 'Safe4wiki needs Node.js. Install it, then open Safe4wiki again.'
  exit 1
fi
if [[ ! -f dist/index.html ]]; then
  npm install
  npm run build
fi

# Keep the Terminal window open while Safe4wiki is in use.
exec node server/index.js --open
