FROM golang:1.25-alpine AS builder
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN VERSION=$(cat VERSION) && CGO_ENABLED=0 go build -ldflags="-X main.version=$VERSION" -o mdnotes .

FROM scratch
COPY --from=builder /build/mdnotes /mdnotes
EXPOSE 8080
WORKDIR /data
VOLUME /data
CMD ["/mdnotes"]
