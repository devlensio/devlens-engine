from rest_framework import viewsets
from .models import Post, User


class UserViewSet(viewsets.ModelViewSet):
    queryset = User.objects.all()


class PostViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = Post.objects.all()
