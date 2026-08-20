FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1
WORKDIR /app/lora-manager
COPY lora-manager/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
EXPOSE 7861
CMD ["sh", "-c", "python write_settings.py && python standalone.py --host 0.0.0.0 --port 7861"]
