// Autocompletado de shell: `drop completion bash|zsh|fish|powershell`.

pub const COMMANDS: &[(&str, &str)] = &[
    ("send", "Envía archivos, carpetas o stdin (-)"),
    ("recv", "Recibe con un código o enlace"),
    ("speed", "Mide la velocidad entre dos CLI"),
    ("update", "Instala la última versión"),
    ("install", "Instala drop en el sistema"),
    ("uninstall", "Desinstala drop"),
    ("completion", "Imprime el autocompletado de un shell"),
    ("verify-web", "Comprueba que la web sirve el código del repositorio"),
];

pub struct FlagSpec {
    pub flag: &'static str,
    pub cmds: &'static [&'static str],
    pub desc: &'static str,
    pub arg: Option<&'static str>,
}

pub const FLAGS: &[FlagSpec] = &[
    FlagSpec { flag: "--server", cmds: &[], desc: "Servidor de señalización", arg: Some("url") },
    FlagSpec { flag: "-s", cmds: &[], desc: "Servidor de señalización", arg: Some("url") },
    FlagSpec { flag: "--out", cmds: &["recv"], desc: "Carpeta de destino (- es stdout)", arg: Some("dir") },
    FlagSpec { flag: "-o", cmds: &["recv"], desc: "Carpeta de destino (- es stdout)", arg: Some("dir") },
    FlagSpec { flag: "--stdout", cmds: &["recv"], desc: "Vuelca lo recibido a stdout", arg: None },
    FlagSpec { flag: "--overwrite", cmds: &["recv"], desc: "Sobrescribe lo que ya exista", arg: None },
    FlagSpec { flag: "--no-resume", cmds: &["recv"], desc: "No reanuda un .part", arg: None },
    FlagSpec { flag: "--only", cmds: &["recv"], desc: "Solo los archivos que casen (*.jpg,fotos/**)", arg: Some("text") },
    FlagSpec { flag: "--text", cmds: &["send"], desc: "Envía ese texto como message.txt", arg: Some("text") },
    FlagSpec { flag: "--clipboard", cmds: &["send"], desc: "Envía el portapapeles", arg: None },
    FlagSpec { flag: "--name", cmds: &["send"], desc: "Nombre para lo que viene de stdin", arg: Some("text") },
    FlagSpec { flag: "--once", cmds: &["send"], desc: "Cierra tras la primera descarga", arg: None },
    FlagSpec { flag: "--expire", cmds: &["send"], desc: "Caduca pasado ese tiempo (90s, 10m, 2h)", arg: Some("text") },
    FlagSpec { flag: "--no-qr", cmds: &["send"], desc: "No pinta el QR", arg: None },
    FlagSpec { flag: "--yes", cmds: &["send"], desc: "No pide confirmación por receptor", arg: None },
    FlagSpec { flag: "-y", cmds: &["send"], desc: "No pide confirmación por receptor", arg: None },
    FlagSpec { flag: "--port", cmds: &["send", "speed"], desc: "Puerto TCP local", arg: Some("text") },
    FlagSpec { flag: "-p", cmds: &["send", "speed"], desc: "Puerto TCP local", arg: Some("text") },
    FlagSpec { flag: "--limit", cmds: &["send", "recv"], desc: "Límite de ancho de banda (500K, 10M)", arg: Some("text") },
    FlagSpec { flag: "--relay", cmds: &["send", "recv", "speed"], desc: "Fuerza el relay por el servidor", arg: None },
    FlagSpec { flag: "--direct-only", cmds: &["speed"], desc: "Solo TCP directo", arg: None },
    FlagSpec { flag: "--time", cmds: &["speed"], desc: "Segundos por fase", arg: Some("text") },
    FlagSpec { flag: "-t", cmds: &["speed"], desc: "Segundos por fase", arg: Some("text") },
    FlagSpec { flag: "--force", cmds: &["update"], desc: "Reinstala aunque esté al día", arg: None },
    FlagSpec { flag: "--allow-unsigned", cmds: &["update"], desc: "Acepta una release sin firma", arg: None },
    FlagSpec { flag: "--skip-verify", cmds: &["update"], desc: "Sin firma ni hash (no recomendado)", arg: None },
    FlagSpec { flag: "--update", cmds: &[], desc: "Igual que \"drop update\"", arg: None },
    FlagSpec { flag: "--help", cmds: &[], desc: "Muestra la ayuda", arg: None },
    FlagSpec { flag: "-h", cmds: &[], desc: "Muestra la ayuda", arg: None },
    FlagSpec { flag: "--version", cmds: &[], desc: "Muestra la versión", arg: None },
    FlagSpec { flag: "-v", cmds: &[], desc: "Muestra la versión", arg: None },
];

pub const SHELLS: &[&str] = &["bash", "zsh", "fish", "powershell"];

fn flags_for(cmd: &str) -> Vec<&'static FlagSpec> {
    FLAGS
        .iter()
        .filter(|f| f.cmds.is_empty() || f.cmds.contains(&cmd))
        .collect()
}

fn long_flags(list: &[&'static FlagSpec]) -> String {
    list.iter()
        .map(|f| f.flag)
        .filter(|s| s.starts_with("--"))
        .collect::<Vec<_>>()
        .join(" ")
}

fn bash() -> String {
    let cmds = COMMANDS.iter().map(|(c, _)| *c).collect::<Vec<_>>().join(" ");
    let per_cmd = COMMANDS
        .iter()
        .map(|(c, _)| format!("    {c}) flags=\"{}\" ;;", long_flags(&flags_for(c))))
        .collect::<Vec<_>>()
        .join("\n");
    let shells_w = SHELLS.join(" ");
    let root_flags = long_flags(&flags_for(""));

    format!(
        r#"# drop: autocompletado para bash. Cárgalo con:
#   eval "$(drop completion bash)"
_drop() {{
  local cur prev cmd flags i
  COMPREPLY=()
  cur="${{COMP_WORDS[COMP_CWORD]}}"
  prev="${{COMP_WORDS[COMP_CWORD-1]}}"
  cmd=""
  for ((i = 1; i < COMP_CWORD; i++)); do
    case "${{COMP_WORDS[i]}}" in
      -*) ;;
      *) cmd="${{COMP_WORDS[i]}}"; break ;;
    esac
  done
  case "$prev" in
    -o|--out) COMPREPLY=( $(compgen -d -- "$cur") ); return ;;
    -s|--server|--text|--name|--expire|--limit|--only|-p|--port|-t|--time) return ;;
    completion) COMPREPLY=( $(compgen -W "{shells_w}" -- "$cur") ); return ;;
  esac
  if [[ -z "$cmd" ]]; then
    if [[ "$cur" == -* ]]; then
      COMPREPLY=( $(compgen -W "{root_flags}" -- "$cur") )
    else
      COMPREPLY=( $(compgen -W "{cmds}" -- "$cur") $(compgen -f -- "$cur") )
    fi
    return
  fi
  case "$cmd" in
{per_cmd}
    *) flags="" ;;
  esac
  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "$flags" -- "$cur") )
  elif [[ "$cmd" == "send" ]]; then
    COMPREPLY=( $(compgen -f -- "$cur") )
  fi
}}
complete -o filenames -F _drop drop
"#
    )
}

fn zsh() -> String {
    let cmd_lines = COMMANDS
        .iter()
        .map(|(c, d)| format!("    '{c}:{}'", d.replace('\'', "'\\''")))
        .collect::<Vec<_>>()
        .join("\n");
    let flag_line = |f: &FlagSpec| -> String {
        let desc: String = f
            .desc
            .chars()
            .map(|ch| if matches!(ch, '[' | ']' | ':') { ' ' } else { ch })
            .collect();
        match f.arg {
            Some("dir") => format!("'{}[{desc}]:carpeta:_directories'", f.flag),
            Some(arg) => format!("'{}[{desc}]:{arg}:'", f.flag),
            None => format!("'{}[{desc}]'", f.flag),
        }
    };
    let shells_list = SHELLS.join(" ");
    let per_cmd = COMMANDS
        .iter()
        .map(|(c, _)| {
            let fl = flags_for(c)
                .into_iter()
                .map(flag_line)
                .collect::<Vec<_>>()
                .join(" \\\n        ");
            let extra = match *c {
                "send" => " \\\n        '*:archivo:_files'".to_string(),
                "completion" => format!(" \\\n        '1:shell:({shells_list})'"),
                _ => String::new(),
            };
            format!("    {c})\n      _arguments -s \\\n        {fl}{extra}\n      ;;")
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        r#"#compdef drop
# drop: autocompletado para zsh. Cárgalo con:
#   eval "$(drop completion zsh)"
# o guárdalo como _drop en un directorio de $fpath.
_drop() {{
  local -a cmds
  cmds=(
{cmd_lines}
  )
  if (( CURRENT == 2 )); then
    _describe 'orden' cmds
    _files
    return
  fi
  case "${{words[2]}}" in
{per_cmd}
  esac
}}
compdef _drop drop
"#
    )
}

fn fish() -> String {
    let mut lines = vec![
        "# drop: autocompletado para fish. Guárdalo en ~/.config/fish/completions/drop.fish:".to_string(),
        "#   drop completion fish > ~/.config/fish/completions/drop.fish".to_string(),
        "complete -c drop -f".to_string(),
    ];
    let cmd_names = COMMANDS.iter().map(|(c, _)| *c).collect::<Vec<_>>().join(" ");
    let no_cmd = format!("-n \"not __fish_seen_subcommand_from {cmd_names}\"");
    for (c, d) in COMMANDS {
        lines.push(format!(
            "complete -c drop {no_cmd} -a {c} -d '{}'",
            d.replace('\'', "\\'")
        ));
    }
    lines.push("complete -c drop -n \"__fish_seen_subcommand_from send\" -F".to_string());
    lines.push(format!(
        "complete -c drop -n \"__fish_seen_subcommand_from completion\" -a \"{}\"",
        SHELLS.join(" ")
    ));
    for f in FLAGS {
        let cond = if f.cmds.is_empty() {
            String::new()
        } else {
            format!("-n \"__fish_seen_subcommand_from {}\"", f.cmds.join(" "))
        };
        let opt = if let Some(long) = f.flag.strip_prefix("--") {
            format!("-l {long}")
        } else {
            format!("-s {}", &f.flag[1..])
        };
        let req = match f.arg {
            Some("dir") => " -r -a \"(__fish_complete_directories)\"",
            Some(_) => " -r",
            None => "",
        };
        let raw = format!(
            "complete -c drop {cond} {opt}{req} -d '{}'",
            f.desc.replace('\'', "\\'")
        );
        // Colapsa espacios repetidos igual que `.replace(/\s+/g, ' ')` en JS
        let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        lines.push(collapsed);
    }
    format!("{}\n", lines.join("\n"))
}

fn powershell() -> String {
    let cmds = COMMANDS
        .iter()
        .map(|(c, d)| format!("    @{{ n = '{c}'; d = '{}' }}", d.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join("\n");
    let flags = FLAGS
        .iter()
        .map(|f| {
            let cs = f
                .cmds
                .iter()
                .map(|x| format!("'{x}'"))
                .collect::<Vec<_>>()
                .join(",");
            format!(
                "    @{{ n = '{}'; c = @({cs}); d = '{}' }}",
                f.flag,
                f.desc.replace('\'', "''")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let shells_joined = SHELLS.join("','");

    format!(
        r#"# drop: autocompletado para PowerShell. Cárgalo con:
#   drop completion powershell | Out-String | Invoke-Expression
# o añade esa línea a tu $PROFILE.
Register-ArgumentCompleter -Native -CommandName drop -ScriptBlock {{
  param($wordToComplete, $commandAst, $cursorPosition)
  $cmds = @(
{cmds}
  )
  $flags = @(
{flags}
  )
  $words = $commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object {{ $_.ToString() }}
  $cmd = $words | Where-Object {{ $_ -notlike '-*' }} | Select-Object -First 1
  if ($cmd -eq 'completion') {{
    '{shells_joined}' -split ',' | Where-Object {{ $_ -like "$wordToComplete*" }} | ForEach-Object {{
      [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }}
    return
  }}
  if ($wordToComplete -like '-*') {{
    $flags | Where-Object {{ $_.n -like "$wordToComplete*" -and ($_.c.Count -eq 0 -or $_.c -contains $cmd) }} | ForEach-Object {{
      [System.Management.Automation.CompletionResult]::new($_.n, $_.n, 'ParameterName', $_.d)
    }}
    return
  }}
  if (-not $cmd) {{
    $cmds | Where-Object {{ $_.n -like "$wordToComplete*" }} | ForEach-Object {{
      [System.Management.Automation.CompletionResult]::new($_.n, $_.n, 'ParameterValue', $_.d)
    }}
  }}
}}
"#
    )
}

pub fn completion_script(shell: Option<&str>) -> Result<String, String> {
    let raw = shell.unwrap_or("");
    match raw.to_ascii_lowercase().as_str() {
        "bash" => Ok(bash()),
        "zsh" => Ok(zsh()),
        "fish" => Ok(fish()),
        "powershell" | "pwsh" => Ok(powershell()),
        _ => {
            let quoted = match shell {
                Some(s) => serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\"")),
                None => "undefined".to_string(),
            };
            Err(format!(
                "Shell no reconocido: {quoted}. Vale uno de: {}.",
                SHELLS.join(", ")
            ))
        }
    }
}
