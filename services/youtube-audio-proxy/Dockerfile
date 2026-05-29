FROM python:3.12-slim-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .

# CPU-only PyTorch keeps image smaller; demucs uses it for vocal separation
RUN pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu \
  && pip install --no-cache-dir -r requirements.txt

COPY app.py .

ENV PORT=8080
ENV WAVRICK_VOCAL_SEPARATION=1
ENV WAVRICK_DEMUCS_MODEL=htdemucs
EXPOSE 8080

CMD ["python", "app.py"]
