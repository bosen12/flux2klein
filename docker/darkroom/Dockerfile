FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1
RUN pip install --no-cache-dir Pillow
WORKDIR /app/darkroom
EXPOSE 7860
CMD ["python", "preview_ui.py"]
