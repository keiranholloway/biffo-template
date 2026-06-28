#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

ok()   { echo -e "${GREEN}✔${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
err()  { echo -e "${RED}✘${NC} $1"; exit 1; }

echo ""
echo "  Biffo — Development Bootstrap"
echo ""

# Required tools
command -v node >/dev/null 2>&1 || err "Node.js 22+ is required. Install via https://nodejs.org"
node_version=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
[[ "$node_version" -ge 22 ]] || err "Node.js 22+ required, found v${node_version}"
ok "Node.js $(node --version)"

command -v pnpm >/dev/null 2>&1 || err "pnpm required. Install: npm install -g pnpm"
ok "pnpm $(pnpm --version)"

command -v python3 >/dev/null 2>&1 || err "Python 3.13+ required"
ok "Python $(python3 --version)"

command -v uv >/dev/null 2>&1 || err "uv required. Install: curl -LsSf https://astral.sh/uv/install.sh | sh"
ok "uv $(uv --version)"

command -v terraform >/dev/null 2>&1 || warn "Terraform not found — required for infra work. Install via https://developer.hashicorp.com/terraform/install"
command -v terraform >/dev/null 2>&1 && ok "Terraform $(terraform version -json | jq -r '.terraform_version' 2>/dev/null || terraform version | head -1)"

# Install JS dependencies
echo ""
echo "Installing JS dependencies..."
pnpm install
ok "pnpm install complete"

# Install Python dependencies
echo ""
echo "Installing Python dependencies..."
uv sync
ok "uv sync complete"

# Install git hooks
echo ""
echo "Installing git hooks..."
pnpm exec husky
uv run pre-commit install --hook-type commit-msg --hook-type pre-commit
ok "Git hooks installed"

echo ""
ok "Bootstrap complete. Run 'pnpm dev' to start the portal, or 'biffo --help' for CLI usage."
echo ""
