
all:
	docker build -t comlink .
	docker run -v `pwd`:/app -w /app comlink tsc
