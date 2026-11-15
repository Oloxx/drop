// Arranque de servidores TCP dual-stack IPv6/IPv4 con mensajes legibles.

use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4, SocketAddrV6};

use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::TcpListener;

#[derive(Debug)]
pub struct ListenError {
    pub raw: io::Error,
    pub message: String,
}

impl std::fmt::Display for ListenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ListenError {}

pub fn explain_listen_error(err: &io::Error, port: u16) -> String {
    let shown = if port > 0 {
        port.to_string()
    } else {
        "solicitado".to_string()
    };
    match err.kind() {
        io::ErrorKind::AddrInUse => format!(
            "El puerto {shown} ya está en uso: elige otro con -p o deja que drop escoja uno libre."
        ),
        io::ErrorKind::PermissionDenied => format!(
            "Sin permisos para escuchar en el puerto {shown}: por debajo de 1024 hace falta root o administrador. Usa -p con un puerto por encima de 1024."
        ),
        _ => err.to_string(),
    }
}

fn bind_socket(addr: SocketAddr, dual_stack_v6: bool) -> io::Result<TcpListener> {
    let domain = match addr {
        SocketAddr::V4(_) => Domain::IPV4,
        SocketAddr::V6(_) => Domain::IPV6,
    };
    let sock = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))?;
    if dual_stack_v6 {
        sock.set_only_v6(false)?;
    }
    #[cfg(not(windows))]
    sock.set_reuse_address(true)?;
    sock.set_nonblocking(true)?;
    sock.bind(&addr.into())?;
    sock.listen(128)?;
    let std_listener: std::net::TcpListener = sock.into();
    TcpListener::from_std(std_listener)
}

fn is_v6_unavailable(err: &io::Error) -> bool {
    if matches!(
        err.kind(),
        io::ErrorKind::AddrNotAvailable | io::ErrorKind::InvalidInput | io::ErrorKind::Unsupported
    ) {
        return true;
    }
    // Codigos POSIX/Windows tipicos de familia IPv6 deshabilitada (EAFNOSUPPORT)
    matches!(err.raw_os_error(), Some(97 | 47 | 10047))
}

/// Escucha en todas las interfaces (`::` dual-stack con fallback a `0.0.0.0`).
pub fn listen_any_family(port: u16) -> Result<TcpListener, ListenError> {
    let v6 = SocketAddr::V6(SocketAddrV6::new(Ipv6Addr::UNSPECIFIED, port, 0, 0));
    match bind_socket(v6, true) {
        Ok(listener) => Ok(listener),
        Err(err) if is_v6_unavailable(&err) => {
            let v4 = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port));
            bind_socket(v4, false).map_err(|e| ListenError {
                message: explain_listen_error(&e, port),
                raw: e,
            })
        }
        Err(err) => Err(ListenError {
            message: explain_listen_error(&err, port),
            raw: err,
        }),
    }
}
