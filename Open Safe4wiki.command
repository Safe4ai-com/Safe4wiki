#!/bin/zsh

set -e
cd -- "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

port="${PORT:-4317}"
if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
  print "Invalid PORT value: $port"
  exit 1
fi
address="http://localhost:$port"
token_file="${REPOWIKI_HOME:-$HOME/.repowiki}/.session-token"
if health=$(curl --silent --fail --max-time 1 "http://127.0.0.1:$port/api/health") && [[ "$health" == *'"app":"safe4wiki"'* || "$health" == *'"app":"repowiki"'* ]]; then
  if [[ -f "$token_file" && ! -L "$token_file" ]]; then
    tok="$(tr -d '[:space:]' < "$token_file")"
    [[ "$tok" =~ ^[a-f0-9]{64}$ ]] && address="http://localhost:$port/?token=$tok"
  fi
  exec open "$address"
fi

if ! command -v node >/dev/null; then
  print 'Safe4wiki needs Node.js. Install it, then open Safe4wiki again.'
  exit 1
fi
if [[ ! -f dist/index.html ]]; then
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
  npm run build
fi

# Keep the Terminal window open while Safe4wiki is in use.
exec node server/index.js --open
