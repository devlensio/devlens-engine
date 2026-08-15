from celery import Celery, shared_task

app = Celery("tasks")


@shared_task
def send_welcome_email(user_id):
    pass


@app.task
def daily_digest():
    pass
