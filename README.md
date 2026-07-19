<div align="center">

[<img src="http://raw.githubusercontent.com/algertc/ALPR-Database/refs/heads/main/Images/app_icon.svg" width="350px" style="margin-left: 86em;">](https://alprdatabase.org/)

# [ALPR Database](https://alprdatabase.org/)

<h4 align="center">A Fully-Featured Automated License Plate Recognition Database for Blue Iris + CodeProject AI Server</h4>

[![Feature Requests & Roadmap](https://img.shields.io/badge/Feature%20Requests%20&%20Roadmap-5e5ced?style=for-the-badge&logo=starship&logoColor=white&link=https://alprdatabase.featurebase.app/roadmap)](https://alprdatabase.featurebase.app/roadmap) ![Downloads](https://img.shields.io/docker/pulls/algertc/alpr-dashboard?label=downloads&style=for-the-badge&logo=CodeForces&logoColor=white&color=00A1E0) ![Plates Processed](https://img.shields.io/badge/Plates%20Processed-26M+-00A1E0?style=for-the-badge&logo=CodeForces&logoColor=white) ![Release](https://img.shields.io/github/v/release/algertc/ALPR-Database?style=for-the-badge&logoColor=white)

<h4 align="center">
⭐ Please star the repository if you find the project useful ⭐</h4>

<!-- [![Docker Hub](https://img.shields.io/badge/Docker%20Hub-1D63ED?style=for-the-badge&logo=Docker&logoColor=white&link=https://hub.docker.com/r/algertc/alpr-dashboard)](https://hub.docker.com/r/algertc/alpr-dashboard) -->

<!-- ![Docker Pulls](https://img.shields.io/docker/pulls/algertc/alpr-dashboard?style=for-the-badge&logo=docker&logoColor=white&label=Downloads&labelColor=1D63ED&color=1D63ED&link=https%3A%2F%2Fhub.docker.com%2Frepository%2Fdocker%2Falgertc%2Falpr-dashboard%2Fgeneral) -->

<!-- ![Plates Processed](https://img.shields.io/badge/Plates%20Processed-1M+-gray?labelColor=00A1E0&style=for-the-badge&logo=CodeForces&logoColor=white) -->

</div>

<br>

![App Screens](https://raw.githubusercontent.com/algertc/ALPR-Database/refs/heads/main/Images/hero2.png)



## :star2: Overview

I've been using [CodeProject AI](https://github.com/codeproject/CodeProject.AI-Server) with [Mike Lud's](https://github.com/MikeLud) license plate model on [Blue Iris](https://blueirissoftware.com/) for a couple years now, but in this setup, the ALPR doesn't really do a whole lot. Really, you have more of a license plate camera with some OCR as a bonus, and no nice way to take advantage the data other than parsing Blue Iris logs or paying $600+/year for PlateMinder or Rekor ALPR.

This project serves as a complement to a CodeProject Blue Iris setup, giving you a full-featured database to store and _actually use_ your ALPR data, **completely for free.** Complete with the following it has a very solid initial feature set and is a huge upgrade over the standard setup.

#### Features:

- Searchable database & fuzzy search
- Build labeled training sets from your traffic
- Live recognition feed
- Traffic Analytics
- Categorization and filtering
- Store information on known vehicles
- Push notifications
- Automation rules
- Customizable tagging
- Configurable retention
- Flexible API
- HomeAssistant integration
- Permissioned users

<br>

## 🔧 Installation and updates

This community fork builds containers directly from a reviewed Git commit. It
does not download or run installer/update scripts from the former upstream
project, and its Compose files default to the local image
`alpr-dashboard:local` with pulling disabled.

<br>

### Prerequisites

In order to send data and use the application, you will need **ALREADY WORKING ALPR** within Blue Iris. If you are not getting plate numbers in your alert memos, please configure and ensure your ALPR is working before beginning the setup.

You will also need the following installed on your system.

- Docker
- Docker Compose
- Docker engine enabled and running

<br>

> [!TIP]
> If unfamiliar with Docker, an easy way to check all three of these boxes at once is to install [Docker Desktop](https://docs.docker.com/desktop/), which has a GUI and bunch of nice tools.

<br>

Clone the fork, check out the approved commit, and build the local image:

```bash
git clone https://github.com/prsmith777/ALPR-Database-Community.git
cd ALPR-Database-Community
git checkout <approved-commit>
docker build --tag alpr-dashboard:local .
```

Copy `.env.example` to `.env`, fill in both passwords, and keep that file
private. Then start the stack with `docker compose up -d`. Compose refuses to
start while either required password is blank, never pulls the former
upstream application image, and keeps PostgreSQL bound to `127.0.0.1` by
default.

For this owner's staging and production process, including PostgreSQL 17
upgrade and rollback requirements, follow
[`docs/personal-deployment.md`](docs/personal-deployment.md).

<br>
<br>

## ⚙️ Setup

### Get Your API Key

To start sending data, log in to the application and **navigate to settings -> security** in the bottom left hand corner. At the bottom of the page you should see an API key. Click the eye to reveal the key and copy it down for use in Blue Iris.

![enter image description here](https://raw.githubusercontent.com/algertc/ALPR-Database/refs/heads/main/Images/apikey.png)

<br>

### Set up an alert action within Blue Iris:

ALPR recognitions are sent to the `/api/plate-reads` endpoint. Integration
routes under `/api/plate-reads` and `/api/plates` require the API key in either
of these headers:

```http
x-api-key: YOUR_API_KEY
Authorization: Bearer YOUR_API_KEY
```

Do not place an API key in the URL. Query-string credentials such as
`?api_key=...` are rejected. Other application API routes use the signed-in
browser session instead of the integration API key.

We can make use of the built-in macros to dynamically get the alert data and send it as our payload. It should look like this:

    { "ai_dump":&JSON, "Image":"&ALERT_JPEG", "camera":"&CAM", "ALERT_PATH": "&ALERT_PATH", "ALERT_CLIP": "&ALERT_CLIP", "timestamp":"&ALERT_TIME" }

**Set your API key with the `x-api-key` header as seen below.**
![enter image description here](https://raw.githubusercontent.com/algertc/ALPR-Database/refs/heads/main/Images/alert.JPG)

Browser sessions use `HttpOnly`, `SameSite=Lax` cookies. Cookies are non-Secure
by default so direct-LAN HTTP Docker deployments continue to work. Set
`SESSION_COOKIE_SECURE=true` when the application is served over HTTPS. Cookie
security is never inferred from `X-Forwarded-Proto` or other request headers.

See [docs/security-baseline.md](docs/security-baseline.md) for the complete
authentication and failure-handling policy.

Maintainers of this fork should follow the streamlined staging-to-production
process in [docs/personal-deployment.md](docs/personal-deployment.md).


#### Thats it! You're now collecting and storing your ALPR data.

<br>

## :camera: Screenshots

![Live Viewer](https://raw.githubusercontent.com/algertc/ALPR-Database/refs/heads/main/Images/viewer.jpg)
![Live View](https://raw.githubusercontent.com/algertc/ALPR-Database/refs/heads/main/Images/liveview.jpg)
![Dashboard](https://raw.githubusercontent.com/algertc/ALPR-Database/refs/heads/main/Images/dash.jpg)
![TPMS](https://raw.githubusercontent.com/algertc/ALPR-Database/refs/heads/main/Images/tpms.jpg)
![Plate Database](https://raw.githubusercontent.com/algertc/ALPR-Database/refs/heads/main/Images/db.jpg)
![Insights](https://raw.githubusercontent.com/algertc/ALPR-Database/refs/heads/main/Images/insights.jpg)

## :warning: Disclaimer

This is meant to be a helpful project and is still a work-in-progress. There's a good amount of spaghetti vibe coding in here and random things left over from the initial release. Not to be relied on for anything critical.
