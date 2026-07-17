#!/bin/sh
NGINX_RESOLVER=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf)
HOST_GATEWAY=$(getent hosts host.containers.internal | awk '{print $1; exit}')
if [ -n "$LOCAL_LLM_HOST_PORT" ]; then
    LLM_LISTEN_DIRECTIVE="listen ${LOCAL_LLM_HOST_PORT};"
else
    LLM_LISTEN_DIRECTIVE=""
fi
export NGINX_RESOLVER HOST_GATEWAY LLM_LISTEN_DIRECTIVE
envsubst '$NGINX_RESOLVER $HOST_GATEWAY $LLM_LISTEN_DIRECTIVE' < /etc/nginx/conf.d/default.conf.template > /etc/nginx/nginx.conf
exec nginx -g 'daemon off;'
