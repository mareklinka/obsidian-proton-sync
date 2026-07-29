# Alpine-based Squid with SSL bump (intercept) support.
# Alpine's squid package is compiled with --enable-ssl --enable-ssl-crtd.

FROM alpine:3.23

RUN apk add --no-cache \
    squid \
    ca-certificates

COPY squid-entrypoint.sh /usr/local/bin/squid-entrypoint.sh
RUN chmod +x /usr/local/bin/squid-entrypoint.sh

RUN mkdir /var/lib/squid/

EXPOSE 3128

ENTRYPOINT ["squid-entrypoint.sh"]
CMD ["-N", "-f", "/etc/squid/squid.conf"]
