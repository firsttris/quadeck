import type { QuadletType } from '~/shared/quadlets'

export interface Template {
  id: string
  label: string
  type: QuadletType
  content: (name: string) => string
}

export const TEMPLATES: Template[] = [
  {
    id: 'web',
    label: 'Webdienst mit Port',
    type: 'container',
    content: (n) => `[Unit]
Description=${n}
After=network-online.target

[Container]
Image=docker.io/library/nginx:latest
ContainerName=${n}
AutoUpdate=registry
PublishPort=8080:80
Volume=/srv/${n}:/usr/share/nginx/html:Z
Environment=TZ=Europe/Berlin

[Service]
Restart=always
TimeoutStartSec=900

[Install]
WantedBy=multi-user.target
`,
  },
  {
    id: 'postgres',
    label: 'PostgreSQL-Datenbank',
    type: 'container',
    content: (n) => `[Unit]
Description=${n} (PostgreSQL)

[Container]
Image=docker.io/library/postgres:16
ContainerName=${n}
AutoUpdate=registry
Volume=/srv/${n}/data:/var/lib/postgresql/data:Z
Environment=POSTGRES_USER=app
Environment=POSTGRES_DB=app
# Passwort besser als Podman-Secret: Secret=${n}-password,type=env,target=POSTGRES_PASSWORD
Environment=POSTGRES_PASSWORD=bitte-ändern
HealthCmd=pg_isready -U app
HealthInterval=30s

[Service]
Restart=always

[Install]
WantedBy=multi-user.target
`,
  },
  {
    id: 'container',
    label: 'Leerer Container',
    type: 'container',
    content: (n) => `[Unit]
Description=${n}

[Container]
Image=
ContainerName=${n}

[Service]
Restart=always

[Install]
WantedBy=multi-user.target
`,
  },
  { id: 'network', label: 'Netzwerk', type: 'network', content: (n) => `[Network]\nNetworkName=${n}\n` },
  { id: 'volume', label: 'Volume', type: 'volume', content: (n) => `[Volume]\nVolumeName=${n}\n` },
  { id: 'pod', label: 'Pod', type: 'pod', content: (n) => `[Pod]\nPodName=${n}\nPublishPort=8080:80\n\n[Install]\nWantedBy=multi-user.target\n` },
]
