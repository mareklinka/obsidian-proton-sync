# Development container
# Provides the .NET SDK and OpenCode CLI, with source code mounted under /source.

FROM alpine:3.24

RUN apk upgrade --no-cache

RUN apk add --no-cache \
    nodejs \
    npm \
    git \
    ripgrep \
    bash && \
    rm -f /sbin/apk /sbin/apk.static && \
    rm -rf /etc/apk /var/cache/apk /var/lib/apk

RUN echo $SHELL

WORKDIR /source

# Install OpenCode and Claude CLI.
RUN npm i -g opencode-ai
RUN npm i -g @anthropic-ai/claude-code

ENV PATH="/root/.opencode/bin::${PATH}"
ENV SHELL="/bin/bash"

ENTRYPOINT [ "/bin/bash" ]
CMD [ "-l", "-c", "echo 'Source mounted at /source. Run \"opencode\" or \"claude\" to start coding.'; exec /bin/bash" ]
