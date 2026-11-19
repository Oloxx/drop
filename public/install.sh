#!/bin/sh
# Instalador de drop CLI para macOS y Linux
# Uso: curl -fsSL https://drop.oloxx.dev/install.sh | sh
set -eu

REPO="Oloxx/drop"

need_cmd() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "Error: se requiere '$1' para instalar drop." >&2
        exit 1
    }
}

need_cmd curl
need_cmd tar

OS_RAW="$(uname -s)"
ARCH_RAW="$(uname -m)"

case "$OS_RAW" in
    Darwin) OS="macos" ;;
    Linux)  OS="linux" ;;
    *)
        echo "Error: sistema operativo no soportado ($OS_RAW)." >&2
        exit 1
        ;;
esac

case "$ARCH_RAW" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64|amd64)  ARCH="x64" ;;
    *)
        echo "Error: arquitectura no soportada ($ARCH_RAW)." >&2
        exit 1
        ;;
esac

if [ "$OS" = "macos" ] && [ "$ARCH" != "arm64" ]; then
    echo "Error: los binarios precompilados de macOS son para Apple Silicon (arm64)." >&2
    echo "Puedes compilar desde el código fuente con: cargo build --release --manifest-path cli/Cargo.toml" >&2
    exit 1
fi

echo ""
echo "  Buscando última versión de drop..."

TAG=""
if [ -n "${DROP_VERSION:-}" ]; then
    case "$DROP_VERSION" in
        v*|V*) TAG="v${DROP_VERSION#?}" ;;
        *)     TAG="v$DROP_VERSION" ;;
    esac
else
    REDIRECT_URL="$(curl -fsSI -o /dev/null -w '%{redirect_url}' "https://github.com/$REPO/releases/latest" || true)"
    case "$REDIRECT_URL" in
        */tag/*) TAG="${REDIRECT_URL##*/}" ;;
    esac
fi

if [ -z "$TAG" ]; then
    echo "Error: no se pudo determinar la última versión de drop." >&2
    exit 1
fi

ASSET="drop-${TAG}-${OS}-${ARCH}.tar.gz"
BASE_URL="https://github.com/$REPO/releases/download/$TAG"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

echo "  Descargando ${ASSET}..."
curl -fsSL "$BASE_URL/$ASSET" -o "$TMP_DIR/$ASSET"
curl -fsSL "$BASE_URL/SHA256SUMS" -o "$TMP_DIR/SHA256SUMS"

EXPECTED="$(awk -v target="$ASSET" '
    {
        name = $2
        sub(/^\*/, "", name)
        sub(/^\.\//, "", name)
        if (name == target) { print tolower($1); exit }
    }
' "$TMP_DIR/SHA256SUMS")"

if [ -z "$EXPECTED" ]; then
    echo "Error: no se encontró el hash de $ASSET en SHA256SUMS." >&2
    exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$TMP_DIR/$ASSET" | awk '{print tolower($1)}')"
elif command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "$TMP_DIR/$ASSET" | awk '{print tolower($1)}')"
else
    echo "Error: no se encontró sha256sum ni shasum para verificar la descarga." >&2
    exit 1
fi

if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "Error: SHA-256 no coincide para $ASSET." >&2
    echo "  Esperado: $EXPECTED" >&2
    echo "  Recibido: $ACTUAL" >&2
    exit 1
fi

echo "  ✔ SHA-256 verificado ($(printf '%.12s' "$ACTUAL"))."

tar -xzf "$TMP_DIR/$ASSET" -C "$TMP_DIR"
BIN="$(find "$TMP_DIR" -maxdepth 2 -type f \( -name 'drop' -o -name 'drop-*' \) ! -name '*.tar.gz' | head -n 1)"
if [ -z "$BIN" ]; then
    echo "Error: no se encontró el binario dentro de $ASSET." >&2
    exit 1
fi

chmod +x "$BIN"
"$BIN" install
