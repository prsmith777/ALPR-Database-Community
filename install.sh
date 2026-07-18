#!/bin/bash

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # Reset


log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

is_docker_running() {
    if docker info >/dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

download_file() {
    local url=$1
    local output_file=$2
    
    if command_exists curl; then
        curl -sSL "$url" -o "$output_file"
    elif command_exists wget; then
        wget -q "$url" -O "$output_file"
    else
        log_error "Neither curl nor wget is installed. Please install either one and try again."
        exit 1
    fi
}

run_docker_compose() {
    if docker compose version >/dev/null 2>&1; then
        docker compose up -d
    elif docker-compose version >/dev/null 2>&1; then
        docker-compose up -d
    else
        log_error "Neither 'docker compose' nor 'docker-compose' commands are working."
        log_error "Please ensure Docker Compose is properly installed."
        exit 1
    fi
}

if [[ -f "docker-compose.yml" ]] || [[ -d "auth" ]] || [[ -d "config" ]] || [[ -d "storage" ]]; then
    log_error "An existing installation was detected in this directory."
    log_info "If you want to update an existing installation, please use the update script provided in the GitHub repository instead."
    log_info "If you encountered an error or need to edit your configuration inputs, delete the directory and start over or manually edit the values in the compose file."
    exit 1
fi

echo -e "\n${BLUE}=========================================${NC}"
echo -e "${BLUE}   ALPR Database Installation Script${NC}"
echo -e "${BLUE}=========================================${NC}\n"


log_info "Checking system requirements..."

if ! command_exists docker; then
    log_error "Docker is not installed. Please install Docker and try again."
    log_info "Visit https://docs.docker.com/get-docker/ for installation instructions."
    exit 1
fi

if ! is_docker_running; then
    log_error "Docker daemon is not running. Please start Docker and try again."
    exit 1
fi

if ! command_exists docker compose && ! command_exists docker-compose; then
    log_error "Docker Compose is not installed. Please install Docker Compose and try again."
    log_info "Visit https://docs.docker.com/compose/install/ for installation instructions."
    exit 1
fi

log_success "All system requirements met!"

#Create host mountpoints for the persistent docker volumes
log_info "Creating required directories..."
mkdir -p auth config storage
log_success "Directories created successfully!"

log_info "Downloading required files..."

COMPOSE_URL="https://raw.githubusercontent.com/algertc/ALPR-Database/refs/heads/main/docker-compose.yml"
SCHEMA_URL="https://raw.githubusercontent.com/algertc/ALPR-Database/refs/heads/main/schema.sql"
MIGRATIONS_URL="https://raw.githubusercontent.com/algertc/ALPR-Database/refs/heads/main/migrations.sql"
UPDATE_URL="https://raw.githubusercontent.com/algertc/ALPR-Database/refs/heads/main/update.sh"

download_file "$COMPOSE_URL" "docker-compose.yml"
download_file "$SCHEMA_URL" "schema.sql"
download_file "$MIGRATIONS_URL" "migrations.sql"
download_file "$UPDATE_URL" "update.sh"

log_success "Files downloaded successfully!"

read_secret() {
    local target=$1
    local prompt=$2
    local value

    while true; do
        echo -en "${BOLD}${prompt}${NC} (minimum 12 characters): "
        read -r -s value </dev/tty
        echo

        if [ "${#value}" -lt 12 ]; then
            log_error "Password must contain at least 12 characters."
        elif [[ "$value" == *"'"* ]]; then
            log_error "Password cannot contain a single quote (')."
        else
            printf -v "$target" '%s' "$value"
            return
        fi
    done
}

write_env_file() {
    umask 077
    {
        printf "ADMIN_PASSWORD='%s'\n" "$ADMIN_PASSWORD"
        printf "DB_PASSWORD='%s'\n" "$DB_PASSWORD"
        printf "TZ='%s'\n" "$TZ"
        printf "APP_PORT='%s'\n" "$APP_PORT"
        printf "DB_PORT='%s'\n" "$DB_PORT"
    } > .env
    chmod 600 .env
}

echo -e "\n${BLUE}=========================================${NC}"
log_info "Configure your installation (Leave blank and hit enter to use default):"
echo ""

read_secret ADMIN_PASSWORD "Create an admin password to log into the web app"
echo
read_secret DB_PASSWORD "Create a secure password for your SQL database"
echo

echo -e "\nSelect your timezone:\n"
echo "1) America/Los_Angeles (US Pacific)"
echo "2) America/Denver (US Mountain)"
echo "3) America/Chicago (US Central)"
echo "4) America/New_York (US Eastern)"
echo "5) Europe/London (UK)"
echo "6) Europe/Paris (Central Europe)"
echo "7) Asia/Tokyo (Japan)"
echo "8) Australia/Sydney (Australia Eastern)"
echo "9) Other - manual entry (Must be an official TZ formatted as COUNTRY/REGION)"

while true; do
    echo -en "${BOLD}Enter a number from the list above (1-9):${NC} "
    read tz_choice </dev/tty
    case $tz_choice in
        1) TZ="America/Los_Angeles"; break;;
        2) TZ="America/Denver"; break;;
        3) TZ="America/Chicago"; break;;
        4) TZ="America/New_York"; break;;
        5) TZ="Europe/London"; break;;
        6) TZ="Europe/Paris"; break;;
        7) TZ="Asia/Tokyo"; break;;
        8) TZ="Australia/Sydney"; break;;
        9) echo -en "Enter your timezone (e.g., America/Los_Angeles): "
           read TZ </dev/tty
           if [ -n "$TZ" ]; then
               break
           else
               log_error "Timezone cannot be empty"
           fi
           ;;
        *) log_error "Please enter a number between 1 and 9";;
    esac
done

log_info "Using timezone: $TZ"
echo ""

is_port_in_use() {
    local port=$1
    if command_exists nc; then
        nc -z localhost "$port" >/dev/null 2>&1
        return $?
    elif command_exists lsof; then
        lsof -i :"$port" >/dev/null 2>&1
        return $?
    else
        # Fall back to checking if anything is listening on the port
        if command_exists ss; then
            ss -ln | grep -q ":$port "
            return $?
        elif command_exists netstat; then
            netstat -ln | grep -q ":$port "
            return $?
        else
            log_warning "Unable to check port availability. Neither nc, lsof, ss, nor netstat is available."
            return 1
        fi
    fi
}

# Ensure port is available
while true; do
    echo -en "${BOLD}Enter the port you want to expose the application on (default: 3000):${NC} "
    read APP_PORT </dev/tty
    APP_PORT=${APP_PORT:-3000}
    
    if ! [[ "$APP_PORT" =~ ^[0-9]+$ ]]; then
        log_error "Please enter a valid port number"
        continue
    fi
    
    if [ "$APP_PORT" -lt 1024 ] || [ "$APP_PORT" -gt 65535 ]; then
        log_error "Please enter a port number between 1024 and 65535"
        continue
    fi
    
    if is_port_in_use "$APP_PORT"; then
        log_error "Port $APP_PORT is already in use. Please choose a different port."
        continue
    fi
    
    break
done
log_info "Using port $APP_PORT"
echo ""

# Allow alternate expose port to route to internal postgres
while true; do
    echo -en "Alternate Postgres port ${BOLD}(Only recommended if you already have a database running on port 5432 on this host, otherwise hit enter to continue.):${NC} "
    read DB_PORT </dev/tty
    DB_PORT=${DB_PORT:-5432}
    
    if ! [[ "$DB_PORT" =~ ^[0-9]+$ ]]; then
        log_error "Please enter a valid port number"
        continue
    fi
    
    if [ "$DB_PORT" -lt 1024 ] || [ "$DB_PORT" -gt 65535 ]; then
        log_error "Please enter a port number between 1024 and 65535"
        continue
    fi
    
    if [ "$DB_PORT" = "$APP_PORT" ]; then
        log_error "Database port cannot be the same as application port"
        continue
    fi
    
    if is_port_in_use "$DB_PORT"; then
        log_error "Port $DB_PORT is already in use. Please choose a different port."
        continue
    fi
    
    break
done

echo ""

log_info "Writing protected configuration to .env..."
write_env_file
log_success "Configuration completed successfully!"


log_info "Starting the application..."
echo ""
run_docker_compose

# Verify
if [ $? -eq 0 ]; then
    log_success "ALPR Database has been successfully installed and started!"
    echo -e "\n${GREEN}=========================================${NC}"
    echo -e "${GREEN}Installation Complete!${NC}"
    echo -e "${GREEN}=========================================${NC}"
    echo -e "\nYour application is now running: ${BLUE}http://$(hostname):$APP_PORT${NC}"
    echo -e "Credentials were saved to the protected .env file."
else
    log_error "Failed to start the application. Please check the error messages above."
    exit 1
fi
