from django.db import models


class User(models.Model):
    name = models.CharField(max_length=100)
    email = models.EmailField()


class Post(models.Model):
    title = models.CharField(max_length=100)
