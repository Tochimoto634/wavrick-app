FROM python:3.12-slim-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu \
  && pip install --no-cache-dir -r requirements.txt

COPY transcribe.py app.py ./

ENV WHISPERX_DEVICE=cpu
ENV WHISPERX_MODEL=large-v3
ENV WHISPERX_COMPUTE_TYPE=int8

EXPOSE 8081
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8081", "--timeout-keep-alive", "600"]
