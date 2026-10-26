from app import start_all
from flask import Flask

cleanup = start_all()
app = Flask(__name__)
