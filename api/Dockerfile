FROM python:3.11-slim-bookworm
ENV PYTHONUNBUFFERED=1 TF_CPP_MIN_LOG_LEVEL=2 TF_NUM_INTEROP_THREADS=2 TF_NUM_INTRAOP_THREADS=2 OMP_NUM_THREADS=2 DEEPFACE_HOME=/models
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt
COPY biometria.py main.py dev.py test_biometria.py test_dev.py ./
RUN python -m unittest discover -s . -p "test_*.py" -v
RUN python -c 'from biometria import precalentar; precalentar()'
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
