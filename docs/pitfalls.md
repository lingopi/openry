# OpenRY — 开发踩坑记录

> 记录开发过程中遇到的所有坑、根因、解决方案，避免后人重复踩。

---

## 坑 1：macOS Xcode Python 无法 pip install -e

### 现象

```
Defaulting to user installation because normal site-packages is not writeable
error: can't create or remove files in install directory
[Errno 1] Operation not permitted: '.../Python3.framework/.../site-packages/...'
```

### 根因

macOS 自带的 `/usr/bin/python3` 是 Xcode Command Line Tools 捆绑的 Python 3.9，位于系统受保护目录，`pip install`（包括 `--user`）均无写权限。且该 Python 的 setuptools 版本过旧（58.x），不完全支持 PEP 621 `pyproject.toml` 的可编辑安装。

### 影响

- 无法 `pip install -e .` 安装到 PATH
- 无法 `pip install --user` 
- 只能通过 `PYTHONPATH=. python3 -m openry` 运行

### 当前解法（临时）

使用 shell wrapper 脚本 `~/bin/openry` + 将 `~/bin` 加入 `$PATH`：

```bash
# ~/bin/openry
#!/bin/bash
OPENRY_HOME="${OPENRY_HOME:-/path/to/OpenRY}"
cd "$OPENRY_HOME" && PYTHONPATH="$OPENRY_HOME" python3 -m openry "$@"
```

### 终极方案讨论（待实现）

需要考虑不同用户环境：

| 用户类型 | 方案 |
|----------|------|
| **有 Homebrew** | `brew install python@3.11` → `pip3.11 install -e .` |
| **无 Homebrew 但 Xcode Python** | 当前 wrapper 方案，或提供 `install.sh` 自动创建 wrapper |
| **Windows** | pip 安装通常无此问题，标准 `pip install .` 即可 |
| **Linux** | 系统 Python 通常可写，或用 `pipx` / `venv` |

**推荐的一键安装脚本 `install.sh`**：

```bash
#!/bin/bash
set -e

# 1. 检测 Python 环境
if command -v python3.11 &>/dev/null; then
    PYTHON=python3.11
elif command -v python3 &>/dev/null; then
    PYTHON=python3
else
    echo "Error: Python 3 not found. Install via brew: brew install python"
    exit 1
fi

echo "Using: $($PYTHON --version)"

# 2. 安装依赖
$PYTHON -m pip install pyyaml

# 3. 尝试 pip install -e（可能失败，不影响）
$PYTHON -m pip install -e . 2>/dev/null && echo "✓ Installed via pip" || echo "⚠ pip install failed, using wrapper"

# 4. 如果 pip install 失败，创建 wrapper
if ! command -v openry &>/dev/null; then
    WRAPPER_DIR="$HOME/.local/bin"
    mkdir -p "$WRAPPER_DIR"
    cat > "$WRAPPER_DIR/openry" << 'WRAPPER'
#!/bin/bash
OPENRY_HOME="${OPENRY_HOME:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$OPENRY_HOME" && PYTHONPATH="$OPENRY_HOME" python3 -m openry "$@"
WRAPPER
    chmod +x "$WRAPPER_DIR/openry"
    echo "✓ Wrapper installed to $WRAPPER_DIR/openry"
    echo "  Add to PATH: export PATH=\"$WRAPPER_DIR:\$PATH\""
fi

# 5. 验证
openry -c 'echo "openry installed successfully"'
```

---

## 坑 2：Python 3.9 不支持 `X | None` 类型语法

### 现象

```
TypeError: unsupported operand type(s) for |: 'type' and 'NoneType'
```

### 根因

`str | None` 联合类型语法是 Python 3.10+ 特性。Xcode 捆绑的 Python 是 3.9。

### 解法

在每个 `.py` 文件顶部添加：

```python
from __future__ import annotations
```

这会让所有类型注解以字符串形式存储，推迟求值，3.9 即可兼容。

### 影响文件

- `openry/cli.py`
- `openry/executor.py`
- `openry/utils.py`
- `openry/config.py`
- `openry/db.py`

全部已修复 ✅
