FROM otel/opentelemetry-collector-contrib:0.102.0

COPY otel-collector-config.yaml /etc/otelcol-contrib/config.yaml

EXPOSE 4318 13133 55679

CMD ["--config=/etc/otelcol-contrib/config.yaml"]