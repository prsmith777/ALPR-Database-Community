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

## 🔧 Installation

![Setup Time](https://img.shields.io/badge/Setup%20Time-%E2%88%BC25%20minutes-0ec423?style=for-the-badge)

The application is packaged as a Docker image. This is the fastest and most reliable way to deploy. Below is a done-for-you installation script that will create a Docker stack with both the application and a PostgreSQL database. The installation script is recommended and more carefully maintained, but manual installation instructions are also available [here](https://github.com/algertc/ALPR-Database/wiki/Manual-Installation).

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

### Linux/MacOS

Create a new directory wherever you would like to store your ALPR data. Enter the directory in your terminal and paste in the below command. After that, everything will be set up automatically!

```bash
curl -sSL https://raw.githubusercontent.com/algertc/ALPR-Database/main/install.sh | bash
```

Or, if you prefer:

```bash
wget -qO- https://raw.githubusercontent.com/algertc/ALPR-Database/main/install.sh | bash
```

<br>

#### :bangbang: Note for Linux:

If your user is not in the Docker group, you will need to run with sudo using the command below:

```bash
curl -sSL https://raw.githubusercontent.com/algertc/ALPR-Database/main/install.sh | sudo bash
```

<br>

### Windows

Create a new directory wherever you would like to store your ALPR data. **Open PowerShell with administrator priveleges and cd into your new install directory.**

Paste in the below commands. After that, everything will be set up automatically!

```shell
Set-ExecutionPolicy RemoteSigned
```

```shell
irm https://raw.githubusercontent.com/algertc/ALPR-Database/main/install.ps1 | iex
```

<br>
<br>

## ⚙️ Setup

### Session Cookie Security

Session cookie protocol security is controlled explicitly with `SESSION_COOKIE_SECURE`:

- Set `SESSION_COOKIE_SECURE=true` when the browser connects over HTTPS, including trusted reverse-proxy deployments that terminate TLS before forwarding to the app.
- Set `SESSION_COOKIE_SECURE=false` for direct LAN HTTP deployments, such as the default Docker setup exposed on port 3000 without HTTPS.
- If `SESSION_COOKIE_SECURE` is not configured, cookies remain compatible with the existing direct-HTTP Docker deployment. Production mode alone is not treated as proof that the browser is using HTTPS.

IP-based middleware authentication is temporarily disabled. The existing whitelist settings and endpoint remain for compatibility, but forwarded headers such as `X-Forwarded-For` are not trusted to grant browser or API access until a separate trusted-proxy design can verify the immediate network peer. Use session login for browser access and API keys for integrations.

<br>

### Get Your API Key

To start sending data, log in to the application and **navigate to settings -> security** in the bottom left hand corner. At the bottom of the page you should see an API key. Click the eye to reveal the key and copy it down for use in Blue Iris.

![enter image description here](https://raw.githubusercontent.com/algertc/ALPR-Database/refs/heads/main/Images/apikey.png)

<br>

### Set up an alert action within Blue Iris:

ALPR recognitions are sent to the `api/plate-reads` endpoint.

We can make use of the built-in macros to dynamically get the alert data and send it as our payload. It should look like this:

    { "ai_dump":&JSON, "Image":"&ALERT_JPEG", "camera":"&CAM", "ALERT_PATH": "&ALERT_PATH", "ALERT_CLIP": "&ALERT_CLIP", "timestamp":"&ALERT_TIME" }

**Set your API key with the x-api-key header as seen below.**
![enter image description here](https://raw.githubusercontent.com/algertc/ALPR-Database/refs/heads/main/Images/alert.JPG)


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
