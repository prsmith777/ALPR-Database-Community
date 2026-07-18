#!/bin/bash

# Script version
SCRIPT_VERSION=2

# Set strict error handling
set -euo pipefail

# Color codes for pretty output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Function to print formatted messages
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

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to download a file with either curl or wget
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

# Function to normalize compose file for comparison
normalize_compose() {
    local file=$1
    # Create a temporary file with normalized content
    sed -E \
        -e 's/ADMIN_PASSWORD=.*/ADMIN_PASSWORD=__PLACEHOLDER__/' \
        -e 's/DB_PASSWORD=.*/DB_PASSWORD=__PLACEHOLDER__/' \
        -e 's/POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=__PLACEHOLDER__/' \
        -e 's/TZ=.*/TZ=__PLACEHOLDER__/' \
        -e 's/"[0-9]+:([0-9]+)"/"__PORT__:\1"/' \
        -e 's/DB_HOST=.*/DB_HOST=__PLACEHOLDER__/' \
        "$file"
}

extract_compose_value() {
    local key=$1
    grep -m1 -E "${key}=" docker-compose.yml 2>/dev/null \
        | sed -E 's/^[^=]*=//; s/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//' \
        || true
}

extract_compose_port() {
    local container_port=$1
    grep -oE "\"(127\\.0\\.0\\.1:)?[0-9]+:${container_port}\"" docker-compose.yml 2>/dev/null \
        | head -n1 \
        | sed -E "s/\"//g; s/^127\\.0\\.0\\.1://; s/:${container_port}$//" \
        || true
}

write_migrated_env() {
    if [ -f .env ]; then
        log_info "Keeping existing .env configuration."
        chmod 600 .env 2>/dev/null || true
        return
    fi

    local admin_password db_password timezone app_port db_port
    admin_password=$(extract_compose_value ADMIN_PASSWORD)
    db_password=$(extract_compose_value DB_PASSWORD)
    if [ -z "$db_password" ]; then
        db_password=$(extract_compose_value POSTGRES_PASSWORD)
    fi
    timezone=$(extract_compose_value TZ)
    app_port=$(extract_compose_port 3000)
    db_port=$(extract_compose_port 5432)

    if [ -z "$admin_password" ] || [ -z "$db_password" ]; then
        log_error "Could not migrate existing passwords. Create .env from .env.example before updating."
        return 1
    fi
    if [[ "$admin_password" == *"'"* ]] || [[ "$db_password" == *"'"* ]]; then
        log_error "Automatic migration cannot encode a password containing a single quote."
        log_error "Create .env manually from .env.example before updating."
        return 1
    fi

    timezone=${timezone:-America/Los_Angeles}
    app_port=${app_port:-3000}
    db_port=${db_port:-5432}

    umask 077
    {
        printf "ADMIN_PASSWORD='%s'\n" "$admin_password"
        printf "DB_PASSWORD='%s'\n" "$db_password"
        printf "TZ='%s'\n" "$timezone"
        printf "APP_PORT='%s'\n" "$app_port"
        printf "DB_PORT='%s'\n" "$db_port"
    } > .env
    chmod 600 .env
    log_success "Existing configuration migrated to protected .env file."
}

validate_compose() {
    if docker compose version >/dev/null 2>&1; then
        docker compose config >/dev/null
    else
        docker-compose config >/dev/null
    fi
}

# Function to run docker compose with proper syntax
run_docker_compose() {
    local cmd=$1
    if docker compose version >/dev/null 2>&1; then
        docker compose $cmd
    elif docker-compose version >/dev/null 2>&1; then
        docker-compose $cmd
    else
        log_error "Neither 'docker compose' nor 'docker-compose' commands are working."
        log_error "Please ensure Docker Compose is properly installed."
        exit 1
    fi
}

# Print welcome message
echo -e "\n${BLUE}=========================================${NC}"
echo -e "${BLUE}   ALPR Database Update Script${NC}"
echo -e "${BLUE}=========================================${NC}\n"

# Display main menu
echo -e "${BOLD}What would you like to do?${NC}"
echo "1) Update"
echo "2) Revert to a previous version"
echo
echo -en "${BOLD}Enter your choice (1-2):${NC} "
read choice

case $choice in
    1)
        # Update path
        echo -e "\n${BOLD}Select release type:${NC}"
        echo "1) Stable (recommended)"
        echo "2) Nightly (pre-release / latest updates)"
        echo
        echo -en "${BOLD}Enter your choice (1-2):${NC} "
        read release_type

        # Set branch based on release type
        if [ "$release_type" = "1" ]; then
            BRANCH="main"
            IMAGE_TAG="latest"
        else
            BRANCH="dev"
            IMAGE_TAG="nightly"
        fi

        # Check for script updates first
        log_info "Checking for script updates..."
        REMOTE_SCRIPT_URL="https://raw.githubusercontent.com/algertc/ALPR-Database/$BRANCH/update.sh"
        if REMOTE_VERSION=$(curl -sSL "$REMOTE_SCRIPT_URL" 2>/dev/null | grep "SCRIPT_VERSION=" | cut -d'=' -f2); then
            if [ -n "$REMOTE_VERSION" ] && [ "$REMOTE_VERSION" -gt "$SCRIPT_VERSION" ]; then
                log_info "A new version of the update script is available."
                log_info "Downloading and executing new version..."
                download_file "$REMOTE_SCRIPT_URL" "update_new.sh"
                chmod +x update_new.sh
                exec ./update_new.sh
                exit 0
            fi
        else
            log_info "No script updates found."
        fi

        # Verify required directories exist
        log_info "Checking required directories..."
        mkdir -p auth config storage
        chmod 755 auth config storage
        log_success "Directory structure verified!"

        # Check for compose file updates
        log_info "Checking for compose file updates..."
        REMOTE_COMPOSE_URL="https://raw.githubusercontent.com/algertc/ALPR-Database/$BRANCH/docker-compose.yml"
        
        if [ -f "docker-compose.yml" ]; then
            # Download remote compose file
            download_file "$REMOTE_COMPOSE_URL" "docker-compose.remote.yml"
            
            # Create normalized versions for comparison
            normalize_compose "docker-compose.yml" > "docker-compose.normalized"
            normalize_compose "docker-compose.remote.yml" > "docker-compose.remote.normalized"
            
            # Compare normalized files
            if ! diff -q "docker-compose.normalized" "docker-compose.remote.normalized" >/dev/null; then
                log_warning "Changes detected in docker-compose.yml"
                echo -e "\nChanges:"
                diff -U0 "docker-compose.normalized" "docker-compose.remote.normalized" || true
                
                echo -en "\n${BOLD}Would you like to update your compose file? (y/n):${NC} "
                read update_compose
                
                if [[ "$update_compose" =~ ^[Yy]$ ]]; then
                    # Update image tag based on release type
                    sed -i.bak "s/:latest/:$IMAGE_TAG/" "docker-compose.remote.yml"

                    write_migrated_env
                    cp docker-compose.yml docker-compose.yml.pre-env-migration
                    mv docker-compose.remote.yml docker-compose.yml
                    if validate_compose; then
                        rm -f docker-compose.yml.pre-env-migration docker-compose.remote.yml.bak
                        log_success "Compose file updated successfully!"
                    else
                        mv docker-compose.yml.pre-env-migration docker-compose.yml
                        log_error "The new Compose configuration was invalid; the original file was restored."
                        exit 1
                    fi
                fi
            fi
            
            # Cleanup temporary files
            rm -f docker-compose.normalized docker-compose.remote.normalized docker-compose.remote.yml
        else
            log_error "No docker-compose.yml found in current directory!"
            exit 1
        fi

        # Update migrations file
        log_info "Updating migrations file..."
        download_file "https://raw.githubusercontent.com/algertc/ALPR-Database/$BRANCH/migrations.sql" "migrations.sql"
        log_success "Migrations file updated!"

        # Stop running containers
        log_info "Stopping running containers..."
        run_docker_compose "down" || {
            log_error "Failed to stop containers:"
            echo "$?"
            exit 1
        }

        # Pull latest images
        log_info "Pulling latest images..."
        run_docker_compose "pull" || {
            log_error "Failed to pull latest images:"
            echo "$?"
            exit 1
        }

        # Start containers
        log_info "Starting updated containers..."
        run_docker_compose "up -d" || {
            log_error "Failed to start containers:"
            echo "$?"
            exit 1
        }

        log_success "Update completed successfully!"
        ;;
        
    2)
        echo -e "\n${YELLOW}Restore functionality will be available in a future update.${NC}"
        exit 0
        ;;
        
    *)
        log_error "Invalid choice. Please try again."
        exit 1
        ;;
esac
