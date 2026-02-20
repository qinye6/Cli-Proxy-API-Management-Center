#!/usr/bin/env bash
# ============================================================
# init-repo.sh — 首次初始化 Auto-Merge 仓库
#
# 使用方法:
#   1. 在 GitHub 上创建一个新的空仓库
#   2. clone 到本地
#   3. 将本目录下的文件复制到仓库根目录
#   4. 运行本脚本：bash scripts/init-repo.sh
#
# 脚本会：
#   - 添加两个上游 remote
#   - 从 fatkun 版拉取代码作为初始基础
#   - 合并 kongkongyo 版代码（新增的监控中心等功能会被保留）
#   - 提交并推送到你的仓库
# ============================================================

set -euo pipefail

# ---------- 配置（可按需修改） ----------
BASE_REPO="https://github.com/fatkun/Cli-Proxy-API-Management-Center.git"
BASE_BRANCH="main"
FEATURE_REPO="https://github.com/kongkongyo/Cli-Proxy-API-Management-Center.git"
FEATURE_BRANCH="main"
# ----------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }

# 检查是否在 git 仓库中
if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  error "当前目录不是 git 仓库。请先创建或 clone 一个仓库。"
  exit 1
fi

# 检查是否有 origin remote
if ! git remote get-url origin &>/dev/null; then
  error "未找到 origin remote。请确保已关联你的 GitHub 仓库。"
  exit 1
fi

info "开始初始化 Auto-Merge 仓库..."

# Step 1: 添加上游 remote
info "Step 1/5: 添加上游仓库 remote..."
git remote add upstream-base "$BASE_REPO" 2>/dev/null && \
  info "  ✅ 已添加 upstream-base (fatkun)" || \
  warn "  ℹ️  upstream-base 已存在，跳过"

git remote add upstream-feature "$FEATURE_REPO" 2>/dev/null && \
  info "  ✅ 已添加 upstream-feature (kongkongyo)" || \
  warn "  ℹ️  upstream-feature 已存在，跳过"

# Step 2: 拉取上游代码
info "Step 2/5: 拉取上游仓库代码..."
git fetch upstream-base "$BASE_BRANCH" --no-tags
git fetch upstream-feature "$FEATURE_BRANCH" --no-tags

# Step 3: 基于 fatkun 版初始化
info "Step 3/5: 基于 fatkun 版创建初始代码..."

# 检查当前分支是否有提交
HAS_COMMITS=$(git log --oneline -1 2>/dev/null && echo "yes" || echo "no")

if [ "$HAS_COMMITS" = "no" ]; then
  # 空仓库，直接 reset 到 fatkun 版
  git reset --hard "upstream-base/$BASE_BRANCH"
else
  # 已有提交，创建新分支
  CURRENT_BRANCH=$(git branch --show-current)
  info "  当前分支: $CURRENT_BRANCH"
  git checkout -B merge-init "upstream-base/$BASE_BRANCH"
fi

# Step 4: 合并 kongkongyo 版（它的新增内容如监控中心会被保留）
info "Step 4/5: 合并 kongkongyo 版代码..."
if git merge "upstream-feature/$FEATURE_BRANCH" \
    --no-edit \
    --allow-unrelated-histories \
    -m "chore: initial merge of fatkun + kongkongyo $(date +%Y-%m-%d)"; then
  info "  ✅ 自动合并成功，无冲突！"
else
  warn "  ⚠️  存在合并冲突！"
  echo ""
  echo "冲突文件："
  git diff --name-only --diff-filter=U
  echo ""
  warn "请手动解决冲突后执行："
  warn "  git add ."
  warn "  git commit"
  warn "  然后手动推送到 origin"
  exit 1
fi

# Step 5: 记录合并状态并推送
info "Step 5/5: 记录合并状态并推送..."
mkdir -p .merge-state
git rev-parse "upstream-base/$BASE_BRANCH" > .merge-state/last-base-sha
git rev-parse "upstream-feature/$FEATURE_BRANCH" > .merge-state/last-feature-sha
date -u +%Y-%m-%dT%H:%M:%SZ > .merge-state/last-merge-time
git add .merge-state/
git commit --amend --no-edit

# 确保 workflow 文件存在
if [ ! -f ".github/workflows/auto-merge.yml" ]; then
  warn "  未找到 workflow 文件，请确保已复制 .github/ 目录"
fi

# 推送到 origin
PUSH_BRANCH=$(git branch --show-current)
info "  推送到 origin/$PUSH_BRANCH ..."
git push origin "$PUSH_BRANCH" --force-with-lease

echo ""
info "============================================"
info "  🎉 初始化完成！"
info "============================================"
echo ""
info "后续步骤："
info "  1. 在 GitHub 仓库设置中启用 Actions"
info "  2. Settings → Actions → General："
info "     - Workflow permissions: Read and write"
info "     - ☑ Allow GitHub Actions to create and approve pull requests"
info "  3. 配置 PAT_TOKEN（用于推送 workflow 文件）："
info "     Settings → Secrets → Actions → New repository secret"
info "     Name: PAT_TOKEN"
info "  4. 等待定时任务自动运行，或手动触发 workflow"
echo ""
