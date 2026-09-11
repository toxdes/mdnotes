FROM golang:1.25-alpine AS builder
RUN apk add --no-cache upx
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN VERSION=$(cat VERSION) && \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=$VERSION" -o vylk . && \
    upx -q vylk

FROM scratch
COPY --from=builder /build/vylk /vylk
EXPOSE 8080
WORKDIR /data
VOLUME /data
CMD ["/vylk"]
