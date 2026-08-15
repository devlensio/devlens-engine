from flask import Flask

app = Flask(__name__)

@app.route("/users/<int:user_id>", methods=["GET", "POST"])
def user_detail(user_id):
    return ""

@app.get("/health")
def health():
    return ""
