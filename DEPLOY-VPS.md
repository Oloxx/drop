# Desplegar en un VPS (guía para Oracle Cloud)

Levanta tres contenedores: la app, un **Caddy** que resuelve el HTTPS solo, y un **coturn**
propio como servidor TURN. Con esto la pila entera es gratis y no dependes de nadie.

Antes de empezar necesitas un **dominio** apuntando a la IP pública de tu instancia. Si no
tienes, [DuckDNS](https://www.duckdns.org) da subdominios gratis (`mi-drop.duckdns.org`) y sirve
perfectamente para Let's Encrypt. Sin dominio no hay certificado, y sin HTTPS la app pierde el
portapapeles y la escritura directa a disco.

## 1. Abrir los puertos (en Oracle son DOS sitios)

Esta es la trampa clásica de Oracle Cloud, y donde se atasca todo el mundo: abrir los puertos en
la consola **no basta**, porque la imagen de la máquina trae además su propio cortafuegos.

**a) En la consola de OCI** — *Networking → Virtual Cloud Networks → tu VCN → Security Lists →
Default Security List → Add Ingress Rules*. Origen `0.0.0.0/0` en todas:

| Puerto | Protocolo | Para qué |
|---|---|---|
| 80 | TCP | Let's Encrypt (validación del certificado) |
| 443 | TCP | la app (HTTPS + WebSocket) |
| 3478 | TCP y UDP | TURN |
| 49160-49200 | UDP | los relays que abre el TURN |

**b) Dentro de la máquina.** En las imágenes **Ubuntu** de Oracle hay reglas de `iptables` con un
REJECT al final de la cadena INPUT, así que las nuevas hay que insertarlas **antes** de esa línea:

```bash
sudo iptables -L INPUT --line-numbers        # mira en qué línea está el REJECT
sudo iptables -I INPUT 6 -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 7 -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT 8 -p tcp --dport 3478 -j ACCEPT
sudo iptables -I INPUT 9 -p udp --dport 3478 -j ACCEPT
sudo iptables -I INPUT 10 -p udp --dport 49160:49200 -j ACCEPT
sudo netfilter-persistent save               # si no, se pierden al reiniciar
```

Si tu imagen es **Oracle Linux**, es firewalld y es más corto:

```bash
sudo firewall-cmd --permanent --add-port=80/tcp --add-port=443/tcp \
  --add-port=3478/tcp --add-port=3478/udp --add-port=49160-49200/udp
sudo firewall-cmd --reload
```

## 2. Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER    # cierra sesión y vuelve a entrar
```

## 3. Subir el proyecto

Lo más cómodo es `git init` en local, subirlo a GitHub y clonarlo en la máquina. Alternativa
directa desde Windows, sin repositorio (evitando `node_modules`, que no hace falta allí):

```powershell
tar --exclude=node_modules -czf drop.tgz .
scp -i C:\ruta\a\tu-clave.key drop.tgz ubuntu@TU_IP:~
```

```bash
mkdir -p ~/drop && tar -xzf ~/drop.tgz -C ~/drop && cd ~/drop
```

## 4. Configurar y levantar

```bash
cp .env.example .env
ip -4 addr show                 # la IP privada, para el .env (suele ser 10.0.0.x)
nano .env                       # dominio, IPs y una contraseña larga para el TURN
docker compose up -d --build
```

Caddy tarda unos segundos en sacar el certificado. Comprobaciones:

```bash
curl https://TU_DOMINIO/healthz            # {"ok":true,"rooms":0}
docker compose logs -f drop                # las trazas de salas
docker compose logs caddy | grep -i certificate
```

Para verificar que el TURN responde de verdad, abre la
[herramienta Trickle ICE de WebRTC](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/),
mete `turn:TU_DOMINIO:3478` con tu usuario y contraseña, y comprueba que aparece algún candidato
de tipo `relay`. Si solo salen `host` y `srflx`, el TURN no está llegando: casi siempre es el
paso 1b, o las IPs de `--external-ip`.

Actualizar después de tocar código:

```bash
git pull && docker compose up -d --build
```

## 5. Que Oracle no se lleve tu máquina

Las instancias **Always Free** pueden ser reclamadas si están ociosas: Oracle las marca cuando,
durante 7 días, el percentil 95 de CPU está por debajo del 20 %, la red por debajo del 20 % y
—solo en las A1 de Ampere— la memoria por debajo del 20 %. Un servidor de señalización que se
pasa el día esperando encaja justo en ese perfil.

Dos cosas a tu favor: los criterios se evalúan **juntos**, así que basta con no cumplir uno para
salvarla, y en las A1 la memoria suele ser la más fácil de mantener ocupada de forma estable.
La vía que se usa habitualmente para quitarse el problema de encima es pasar la cuenta a *Pay As
You Go*: los recursos Always Free se siguen sin cobrar, pero la reclamación deja de aplicarse.
Requiere tarjeta, así que compruébalo en tu consola antes de decidir.

Y pase lo que pase, no guardes nada importante ahí: esta app no tiene estado, así que si un día
te reclaman la máquina solo pierdes el rato de volver a levantarla.
