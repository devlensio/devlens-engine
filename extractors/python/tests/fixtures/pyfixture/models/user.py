class User:
    def __init__(self, user_id):
        self.user_id = user_id

    def to_dict(self):
        return {"id": self.user_id}

    @classmethod
    def create(cls, user_id):
        return cls(user_id)
