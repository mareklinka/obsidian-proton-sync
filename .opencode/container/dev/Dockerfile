# Development container
# Provides the .NET SDK and OpenCode CLI, with source code mounted under /source.

FROM alpine:3.24

RUN apk upgrade --no-cache

RUN apk add --no-cache \
    nodejs \
    npm \
    git \
    ripgrep && \
    rm -f /sbin/apk /sbin/apk.static && \
    rm -rf /etc/apk /var/cache/apk /var/lib/apk

WORKDIR /source

ENV PATH="/root/.opencode/bin::${PATH}"

# Install OpenCode CLI.
RUN npm i -g opencode-ai

ENTRYPOINT [ "/bin/bash" ]
CMD [ "-l", "-c", "echo 'Source mounted at /source. Run \"opencode\" to start coding.'; exec /bin/bash" ]
