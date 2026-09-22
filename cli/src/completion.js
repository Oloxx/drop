// Autocompletado de shell: `drop completion bash|zsh|fish|powershell` imprime
// el script y el usuario lo carga desde su perfil. No se instala nada solo:
// tocar el .bashrc de alguien sin que lo pida no es una cortesia.
//
// La tabla de abajo es la UNICA lista de ordenes y flags que conoce el
// autocompletado; `test/version.test.mjs` comprueba que todo flag que parsea
// cli.js esta aqui y en la ayuda, para que anadir uno no lo deje mudo.

export const COMMANDS = [
  ['send', 'Envía archivos, carpetas o stdin (-)'],
  ['recv', 'Recibe con un código o enlace'],
  ['speed', 'Mide la velocidad entre dos CLI'],
  ['update', 'Instala la última versión'],
  ['install', 'Instala drop en el sistema'],
  ['uninstall', 'Desinstala drop'],
  ['completion', 'Imprime el autocompletado de un shell'],
  ['verify-web', 'Comprueba que la web sirve el código del repositorio'],
];

// [flag, para que ordenes (vacio = todas), descripcion, que completa detras]
export const FLAGS = [
  ['--server', [], 'Servidor de señalización', 'url'],
  ['-s', [], 'Servidor de señalización', 'url'],
  ['--out', ['recv'], 'Carpeta de destino (- es stdout)', 'dir'],
  ['-o', ['recv'], 'Carpeta de destino (- es stdout)', 'dir'],
  ['--stdout', ['recv'], 'Vuelca lo recibido a stdout', null],
  ['--overwrite', ['recv'], 'Sobrescribe lo que ya exista', null],
  ['--no-resume', ['recv'], 'No reanuda un .part', null],
  ['--only', ['recv'], 'Solo los archivos que casen (*.jpg,fotos/**)', 'text'],
  ['--text', ['send'], 'Envía ese texto como message.txt', 'text'],
  ['--clipboard', ['send'], 'Envía el portapapeles', null],
  ['--name', ['send'], 'Nombre para lo que viene de stdin', 'text'],
  ['--once', ['send'], 'Cierra tras la primera descarga', null],
  ['--expire', ['send'], 'Caduca pasado ese tiempo (90s, 10m, 2h)', 'text'],
  ['--no-qr', ['send'], 'No pinta el QR', null],
  ['--yes', ['send'], 'No pide confirmación por receptor', null],
  ['-y', ['send'], 'No pide confirmación por receptor', null],
  ['--port', ['send', 'speed'], 'Puerto TCP local', 'text'],
  ['-p', ['send', 'speed'], 'Puerto TCP local', 'text'],
  ['--limit', ['send', 'recv'], 'Límite de ancho de banda (500K, 10M)', 'text'],
  ['--relay', ['send', 'recv', 'speed'], 'Fuerza el relay por el servidor', null],
  ['--direct-only', ['speed'], 'Solo TCP directo', null],
  ['--time', ['speed'], 'Segundos por fase', 'text'],
  ['-t', ['speed'], 'Segundos por fase', 'text'],
  ['--force', ['update'], 'Reinstala aunque esté al día', null],
  ['--allow-unsigned', ['update'], 'Acepta una release sin firma', null],
  ['--skip-verify', ['update'], 'Sin firma ni hash (no recomendado)', null],
  ['--update', [], 'Igual que "drop update"', null],
  ['--help', [], 'Muestra la ayuda', null],
  ['-h', [], 'Muestra la ayuda', null],
  ['--version', [], 'Muestra la versión', null],
  ['-v', [], 'Muestra la versión', null],
];

export const SHELLS = ['bash', 'zsh', 'fish', 'powershell'];

const flagsFor = (cmd) => FLAGS.filter(([, cmds]) => !cmds.length || cmds.includes(cmd)).map(([f]) => f);
const longFlags = (list) => list.filter((f) => f.startsWith('--'));

function bash() {
  const cmds = COMMANDS.map(([c]) => c).join(' ');
  const perCmd = COMMANDS.map(([c]) => `    ${c}) flags="${longFlags(flagsFor(c)).join(' ')}" ;;`).join('\n');
  return `# drop: autocompletado para bash. Cárgalo con:
#   eval "$(drop completion bash)"
_drop() {
  local cur prev cmd flags i
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmd=""
  for ((i = 1; i < COMP_CWORD; i++)); do
    case "\${COMP_WORDS[i]}" in
      -*) ;;
      *) cmd="\${COMP_WORDS[i]}"; break ;;
    esac
  done
  case "$prev" in
    -o|--out) COMPREPLY=( $(compgen -d -- "$cur") ); return ;;
    -s|--server|--text|--name|--expire|--limit|--only|-p|--port|-t|--time) return ;;
    completion) COMPREPLY=( $(compgen -W "${SHELLS.join(' ')}" -- "$cur") ); return ;;
  esac
  if [[ -z "$cmd" ]]; then
    if [[ "$cur" == -* ]]; then
      COMPREPLY=( $(compgen -W "${longFlags(flagsFor('')).join(' ')}" -- "$cur") )
    else
      COMPREPLY=( $(compgen -W "${cmds}" -- "$cur") $(compgen -f -- "$cur") )
    fi
    return
  fi
  case "$cmd" in
${perCmd}
    *) flags="" ;;
  esac
  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "$flags" -- "$cur") )
  elif [[ "$cmd" == "send" ]]; then
    COMPREPLY=( $(compgen -f -- "$cur") )
  fi
}
complete -o filenames -F _drop drop
`;
}

function zsh() {
  const cmdLines = COMMANDS.map(([c, d]) => `    '${c}:${d.replace(/'/g, "'\\''")}'`).join('\n');
  const flagLine = ([f, , d, arg]) => {
    const desc = d.replace(/[\[\]:]/g, ' ');
    if (arg === 'dir') return `'${f}[${desc}]:carpeta:_directories'`;
    if (arg) return `'${f}[${desc}]:${arg}:'`;
    return `'${f}[${desc}]'`;
  };
  const perCmd = COMMANDS.map(([c]) => {
    const fl = FLAGS.filter(([, cmds]) => !cmds.length || cmds.includes(c)).map(flagLine).join(' \\\n        ');
    const extra = c === 'send' ? " \\\n        '*:archivo:_files'" : c === 'completion' ? ` \\\n        '1:shell:(${SHELLS.join(' ')})'` : '';
    return `    ${c})\n      _arguments -s \\\n        ${fl}${extra}\n      ;;`;
  }).join('\n');
  return `#compdef drop
# drop: autocompletado para zsh. Cárgalo con:
#   eval "$(drop completion zsh)"
# o guárdalo como _drop en un directorio de $fpath.
_drop() {
  local -a cmds
  cmds=(
${cmdLines}
  )
  if (( CURRENT == 2 )); then
    _describe 'orden' cmds
    _files
    return
  fi
  case "\${words[2]}" in
${perCmd}
  esac
}
compdef _drop drop
`;
}

function fish() {
  const lines = ['# drop: autocompletado para fish. Guárdalo en ~/.config/fish/completions/drop.fish:',
    '#   drop completion fish > ~/.config/fish/completions/drop.fish',
    'complete -c drop -f'];
  const noCmd = `-n "not __fish_seen_subcommand_from ${COMMANDS.map(([c]) => c).join(' ')}"`;
  for (const [c, d] of COMMANDS) lines.push(`complete -c drop ${noCmd} -a ${c} -d '${d.replace(/'/g, "\\'")}'`);
  lines.push(`complete -c drop -n "__fish_seen_subcommand_from send" -F`);
  lines.push(`complete -c drop -n "__fish_seen_subcommand_from completion" -a "${SHELLS.join(' ')}"`);
  for (const [f, cmds, d, arg] of FLAGS) {
    const cond = cmds.length ? `-n "__fish_seen_subcommand_from ${cmds.join(' ')}"` : '';
    const opt = f.startsWith('--') ? `-l ${f.slice(2)}` : `-s ${f.slice(1)}`;
    const req = arg === 'dir' ? ' -r -a "(__fish_complete_directories)"' : arg ? ' -r' : '';
    lines.push(`complete -c drop ${cond} ${opt}${req} -d '${d.replace(/'/g, "\\'")}'`.replace(/\s+/g, ' '));
  }
  return lines.join('\n') + '\n';
}

function powershell() {
  const cmds = COMMANDS.map(([c, d]) => `    @{ n = '${c}'; d = '${d.replace(/'/g, "''")}' }`).join('\n');
  const flags = FLAGS.map(([f, cmds, d]) => `    @{ n = '${f}'; c = @(${cmds.map((x) => `'${x}'`).join(',')}); d = '${d.replace(/'/g, "''")}' }`).join('\n');
  return `# drop: autocompletado para PowerShell. Cárgalo con:
#   drop completion powershell | Out-String | Invoke-Expression
# o añade esa línea a tu $PROFILE.
Register-ArgumentCompleter -Native -CommandName drop -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $cmds = @(
${cmds}
  )
  $flags = @(
${flags}
  )
  $words = $commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.ToString() }
  $cmd = $words | Where-Object { $_ -notlike '-*' } | Select-Object -First 1
  if ($cmd -eq 'completion') {
    '${SHELLS.join("','")}' -split ',' | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
    return
  }
  if ($wordToComplete -like '-*') {
    $flags | Where-Object { $_.n -like "$wordToComplete*" -and ($_.c.Count -eq 0 -or $_.c -contains $cmd) } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_.n, $_.n, 'ParameterName', $_.d)
    }
    return
  }
  if (-not $cmd) {
    $cmds | Where-Object { $_.n -like "$wordToComplete*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_.n, $_.n, 'ParameterValue', $_.d)
    }
  }
}
`;
}

/** El script de autocompletado para `shell`, o lanza si no lo conocemos. */
export function completionScript(shell) {
  switch (String(shell || '').toLowerCase()) {
    case 'bash': return bash();
    case 'zsh': return zsh();
    case 'fish': return fish();
    case 'powershell': case 'pwsh': return powershell();
    default: {
      const err = new Error(`Shell no reconocido: ${JSON.stringify(shell)}. Vale uno de: ${SHELLS.join(', ')}.`);
      err.code = 'UNKNOWN_SHELL';
      throw err;
    }
  }
}
