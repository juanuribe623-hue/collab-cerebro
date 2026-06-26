# Collab Cerebro

App cliente-facing del cerebro de contenido. Separada del Collab Manager (que es interno de Collab) para que el equipo de cada cliente use SOLO su cerebro de contenido, sin ver datos comerciales de Collab.

- **Multi-tenant:** cada cliente es una `company`. Todos los datos van scoped por `company_id`. Casa Precis es el primer cliente.
- **Stack:** Express + Supabase (auth + datos) + proxy a Claude y Apify. Frontend HTML/CSS/JS vanilla (mismo enfoque que el Collab Manager).
- **Las llaves de Claude y Apify las pone Collab** (env vars del servidor), no el cliente. Así controlamos costo y calidad.

## Setup de infraestructura (lo hace Collab)

1. **Supabase nuevo** (proyecto aparte del de Collab, para aislar datos de cliente):
   - Crear proyecto en supabase.com.
   - SQL Editor -> pegar y correr `db/schema.sql`.
   - Activar Auth (email/password) para los usuarios de cliente.
   - Copiar `SUPABASE_URL` y `SUPABASE_SERVICE_KEY` (service_role).
2. **Railway nuevo** (servicio aparte):
   - Conectar este repo.
   - Variables de entorno: ver `.env.example`.
3. **Sembrar el primer cliente:** en `db/schema.sql` hay un bloque para crear la empresa "Casa Precis" y asignar a los usuarios del equipo (por su UUID de Supabase Auth).

## Flujo de deploy
Editar el HTML del frontend -> copiarlo a `backend/public/index.html` -> `git push` desde `backend/` (Railway auto-deploya). Igual que el Collab Manager.

## Módulos (lo que SÍ va aquí)
Brief/Conocimiento, Banco de Tendencias (Señales), Ideas/Ángulos, Guiones (IG+TikTok), Influencers/BrandFit, Calendario, Insights. **NO** va Pipeline/Hunting/Scout (eso es comercial interno de Collab).
